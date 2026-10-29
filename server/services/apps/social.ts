import { z } from 'zod';
import type { Services } from '../../context.ts';
import type { Row } from '../../db/index.ts';
import type { ToolContext } from '../../tools/registry.ts';
import { api, AppError } from './accounts.ts';
import { GRAPH_FB } from './providers.ts';
import { appTool, account, untrusted, clip, ownDocument, type AppToolDef } from './common.ts';

const enc = encodeURIComponent;
const X_API = 'https://api.x.com/2';
const LI_API = 'https://api.linkedin.com';
const TT_API = 'https://open.tiktokapis.com/v2';
/** Largest file Carino hands to Instagram, Facebook or TikTok from the phone. */
export const MAX_SOCIAL_UPLOAD = 50 * 1024 * 1024;

const preview = (t: string, n = 400) => `“${t.slice(0, n)}${t.length > n ? '…' : ''}”`;

// ---- LinkedIn ------------------------------------------------------------------------------

/** LinkedIn's API version header: a month within the last year (they're supported for a year). */
export function linkedinVersion(now: Date) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** LinkedIn post text treats some characters as markup; hashtags keep working. */
export function linkedinText(text: string) {
  const parts = text.split(/(#[\p{L}\p{N}_]+)/u);
  return parts.map((p, i) => (i % 2 === 1 ? `{hashtag|\\#|${p.slice(1)}}` : p.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`))).join('');
}

// ---- Facebook Pages ------------------------------------------------------------------------

interface Page { id: string; name: string; access_token: string; instagram_business_account?: { id: string } }

async function pages(services: Services, a: Row): Promise<Page[]> {
  const r = await api(services, a, `${GRAPH_FB}/me/accounts?fields=id,name,access_token,instagram_business_account&limit=100`);
  return r.data ?? [];
}

/** The Page a call means: by id or name, or the only one. Its own token is used for posting. */
async function page(services: Services, a: Row, wanted?: string): Promise<Page> {
  const list = await pages(services, a);
  if (!list.length) throw new AppError('This Facebook account doesn’t manage any Pages (Facebook only lets apps post to Pages, not personal profiles).');
  if (!wanted) {
    if (list.length === 1) return list[0];
    throw new AppError(`Which Page? This account manages: ${list.map((p) => p.name).join(', ')}.`);
  }
  const w = wanted.toLowerCase();
  const hit = list.find((p) => p.id === wanted || p.name.toLowerCase() === w) ?? list.find((p) => p.name.toLowerCase().includes(w));
  if (!hit) throw new AppError(`No Page matches “${wanted}”. Pages: ${list.map((p) => p.name).join(', ')}.`);
  return hit;
}

/** Graph calls with a Page token (the account's token is only used to look the Page up). */
async function pageCall(services: Services, a: Row, p: Page, path: string, init: { method?: string; body?: Record<string, unknown>; form?: FormData } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const f = services.netFetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${GRAPH_FB}/${path}${sep}access_token=${enc(p.access_token)}`, {
      method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
      body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AppError('Could not reach Facebook. Check your internet connection.');
  }
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || d.error) {
    if (res.status === 401 || d.error?.code === 190) throw new AppError(`Facebook says the sign-in for ${a.label} is no longer valid. Sign in again in My apps.`);
    throw new AppError(`Facebook: ${String(d.error?.error_user_msg ?? d.error?.message ?? `error ${res.status}`).slice(0, 300)}`);
  }
  return d;
}

async function photoForm(ctx: ToolContext, documentId: string, extra: Record<string, string>) {
  const { doc, buf } = await ownDocument(ctx, documentId);
  if (doc.kind !== 'image') throw new AppError('That file isn’t a photo.');
  if (buf.length > MAX_SOCIAL_UPLOAD) throw new AppError('That photo is too large.');
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  form.set('source', new Blob([new Uint8Array(buf)], { type: doc.mime }), doc.filename);
  return form;
}

// ---- Instagram -----------------------------------------------------------------------------

const IG_FIELDS = 'id,caption,media_type,permalink,timestamp,like_count,comments_count';

/** Instagram takes photos from a public web address: the photo is first stored, unpublished, on the linked Facebook Page. */
async function publicPhotoUrl(ctx: ToolContext, a: Row, documentId: string) {
  const p = (await pages(ctx.services, a)).find((x) => x.instagram_business_account?.id === a.external_id);
  if (!p) throw new AppError('Couldn’t find the Facebook Page linked to this Instagram account. Sign in to Instagram again in My apps.');
  const up = await pageCall(ctx.services, a, p, `${p.id}/photos`, { form: await photoForm(ctx, documentId, { published: 'false' }) });
  const photo = await pageCall(ctx.services, a, p, `${up.id}?fields=images`);
  const url = photo.images?.[0]?.source;
  if (!url) throw new AppError('Facebook didn’t return the photo for Instagram.');
  return url as string;
}

// ---- TikTok --------------------------------------------------------------------------------

async function tiktok(services: Services, a: Row, path: string, body: unknown) {
  const d = await api(services, a, `${TT_API}/${path}`, { body, headers: { 'content-type': 'application/json; charset=UTF-8' } });
  if (d.error?.code && d.error.code !== 'ok') throw new AppError(`TikTok: ${d.error.message || d.error.code}`);
  return d.data ?? {};
}

/**
 * TikTok's chunk rules allow one piece up to 64 MB, or 5–64 MB pieces with the remainder in the
 * last. Carino sends 10 MB pieces above 20 MB, so no single request across the phone's bridge is large.
 */
export function tiktokChunks(size: number) {
  if (size <= 20 * 1024 * 1024) return { chunk_size: size, total_chunk_count: 1 };
  const chunk = 10 * 1024 * 1024;
  return { chunk_size: chunk, total_chunk_count: Math.floor(size / chunk) };
}

export const SOCIAL_TOOLS: AppToolDef[] = [
  // ---- X ----
  appTool('x', {
    name: 'x_profile',
    description: 'The user’s X (Twitter) profile: handle, bio and follower counts.',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'Look at the X profile',
    run: async (i, ctx) => {
      const a = account(ctx, 'x', i);
      const r = await api(ctx.services, a, `${X_API}/users/me?user.fields=description,public_metrics,created_at,verified`);
      return untrusted('X', a, r.data);
    },
  }),
  appTool('x', {
    name: 'x_my_posts',
    description: 'The user’s recent posts on X with likes and reposts. (X’s free plan allows very few reads a month; this may be refused.)',
    risk: 'read',
    input: z.object({ max: z.number().int().min(5).max(50).optional() }),
    summarize: () => 'Look at recent posts on X',
    run: async (i, ctx) => {
      const a = account(ctx, 'x', i);
      const r = await api(ctx.services, a, `${X_API}/users/${enc(a.external_id)}/tweets?max_results=${i.max ?? 10}&tweet.fields=created_at,public_metrics`);
      return untrusted('X', a, { posts: r.data ?? [] });
    },
  }),
  appTool('x', {
    name: 'x_post',
    description: 'Post on X (Twitter) as the user, optionally as a reply. Up to 280 characters on a free account. Always show the user the exact text first.',
    risk: 'consequential',
    input: z.object({ text: z.string().min(1).max(4000), reply_to_post_id: z.string().regex(/^\d{1,25}$/).optional() }),
    summarize: (i) => `Post on X: ${preview(i.text)}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'x', i);
      const r = await api(ctx.services, a, `${X_API}/tweets`, { body: { text: i.text, ...(i.reply_to_post_id ? { reply: { in_reply_to_tweet_id: i.reply_to_post_id } } : {}) } });
      const id = r.data?.id;
      return { posted: true, id, link: id ? `https://x.com/${String(a.label).replace(/^@/, '')}/status/${id}` : undefined };
    },
  }),

  // ---- LinkedIn ----
  appTool('linkedin', {
    name: 'linkedin_profile',
    description: 'The user’s LinkedIn name and email.',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'Look at the LinkedIn profile',
    run: async (i, ctx) => {
      const a = account(ctx, 'linkedin', i);
      const me = await api(ctx.services, a, `${LI_API}/v2/userinfo`);
      return untrusted('LinkedIn', a, { name: me.name, email: me.email, locale: me.locale });
    },
  }),
  appTool('linkedin', {
    name: 'linkedin_post',
    description: 'Publish a post on LinkedIn as the user (public), optionally sharing a link. Hashtags work. Always show the user the exact text first.',
    risk: 'consequential',
    input: z.object({ text: z.string().min(1).max(3000), link: z.string().url().max(2000).optional(), link_title: z.string().max(200).optional() }),
    summarize: (i) => `Post on LinkedIn: ${preview(i.text)}${i.link ? ` (link: ${i.link})` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'linkedin', i);
      await api(ctx.services, a, `${LI_API}/rest/posts`, {
        headers: { 'linkedin-version': linkedinVersion(ctx.now), 'x-restli-protocol-version': '2.0.0' },
        body: {
          author: `urn:li:person:${a.external_id}`, commentary: linkedinText(i.text), visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
          ...(i.link ? { content: { article: { source: i.link, title: i.link_title || i.link } } } : {}),
        },
      });
      return { posted: true, profile: a.label };
    },
  }),

  // ---- Facebook ----
  appTool('facebook', {
    name: 'facebook_pages',
    description: 'The Facebook Pages the user manages (Facebook lets apps post to Pages, not to personal profiles).',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'List Facebook Pages',
    run: async (i, ctx) => {
      const a = account(ctx, 'facebook', i);
      const r = await api(ctx.services, a, `${GRAPH_FB}/me/accounts?fields=id,name,category,fan_count,link&limit=100`);
      return untrusted('Facebook', a, { pages: r.data ?? [] });
    },
  }),
  appTool('facebook', {
    name: 'facebook_page_posts',
    description: 'Recent posts on one of the user’s Facebook Pages, with reaction and comment counts.',
    risk: 'read',
    input: z.object({ page: z.string().max(200).optional().describe('Page name or id; can be left out if they manage one Page'), max: z.number().int().min(1).max(50).optional() }),
    summarize: () => 'Look at Facebook Page posts',
    run: async (i, ctx) => {
      const a = account(ctx, 'facebook', i);
      const p = await page(ctx.services, a, i.page);
      const r = await pageCall(ctx.services, a, p, `${p.id}/posts?limit=${i.max ?? 10}&fields=${enc('id,message,created_time,permalink_url,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)')}`);
      const posts = (r.data ?? []).map((x: any) => ({ id: x.id, message: x.message ? clip(x.message, 2000) : undefined, time: x.created_time, link: x.permalink_url, reactions: x.reactions?.summary?.total_count, comments: x.comments?.summary?.total_count }));
      return untrusted('Facebook', a, { page: p.name, posts });
    },
  }),
  appTool('facebook', {
    name: 'facebook_comments',
    description: 'Comments on a Facebook Page post (id from facebook_page_posts).',
    risk: 'read',
    input: z.object({ post_id: z.string().min(3).max(100), page: z.string().max(200).optional() }),
    summarize: () => 'Read comments on a Facebook post',
    run: async (i, ctx) => {
      const a = account(ctx, 'facebook', i);
      const p = await page(ctx.services, a, i.page ?? i.post_id.split('_')[0]);
      const r = await pageCall(ctx.services, a, p, `${enc(i.post_id)}/comments?limit=50&fields=id,from,message,created_time`);
      return untrusted('Facebook', a, { comments: (r.data ?? []).map((c: any) => ({ id: c.id, from: c.from?.name, message: c.message, time: c.created_time })) });
    },
  }),
  appTool('facebook', {
    name: 'facebook_post',
    description: 'Publish a post on one of the user’s Facebook Pages: text, optionally a link or a photo the user attached in Carino (document id). Always show the user the exact text first.',
    risk: 'consequential',
    input: z.object({ page: z.string().max(200).optional(), message: z.string().min(1).max(10_000), link: z.string().url().max(2000).optional(), photo_document_id: z.string().max(64).optional() }),
    summarize: (i) => `Post on Facebook${i.page ? ` (${i.page})` : ''}: ${preview(i.message)}${i.photo_document_id ? ' with a photo' : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'facebook', i);
      const p = await page(ctx.services, a, i.page);
      const r = i.photo_document_id
        ? await pageCall(ctx.services, a, p, `${p.id}/photos`, { form: await photoForm(ctx, i.photo_document_id, { caption: i.message }) })
        : await pageCall(ctx.services, a, p, `${p.id}/feed`, { body: { message: i.message, ...(i.link ? { link: i.link } : {}) } });
      return { posted: true, page: p.name, id: r.post_id ?? r.id, link: `https://www.facebook.com/${r.post_id ?? r.id}` };
    },
  }),
  appTool('facebook', {
    name: 'facebook_reply',
    description: 'Reply to a comment (or comment on a post) on the user’s Facebook Page, as the Page.',
    risk: 'consequential',
    input: z.object({ id: z.string().min(3).max(100).describe('Comment id or post id'), message: z.string().min(1).max(8000), page: z.string().max(200).optional() }),
    summarize: (i) => `Reply on Facebook: ${preview(i.message)}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'facebook', i);
      const p = await page(ctx.services, a, i.page ?? (i.id.includes('_') ? i.id.split('_')[0] : undefined));
      const r = await pageCall(ctx.services, a, p, `${enc(i.id)}/comments`, { body: { message: i.message } });
      return { replied: true, id: r.id };
    },
  }),

  // ---- Instagram ----
  appTool('instagram', {
    name: 'instagram_profile',
    description: 'The user’s Instagram professional account: username, bio, follower and post counts.',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'Look at the Instagram profile',
    run: async (i, ctx) => {
      const a = account(ctx, 'instagram', i);
      return untrusted('Instagram', a, await api(ctx.services, a, `${GRAPH_FB}/${enc(a.external_id)}?fields=username,name,biography,followers_count,follows_count,media_count,website`));
    },
  }),
  appTool('instagram', {
    name: 'instagram_posts',
    description: 'The user’s recent Instagram posts with likes and comment counts.',
    risk: 'read',
    input: z.object({ max: z.number().int().min(1).max(50).optional() }),
    summarize: () => 'Look at recent Instagram posts',
    run: async (i, ctx) => {
      const a = account(ctx, 'instagram', i);
      const r = await api(ctx.services, a, `${GRAPH_FB}/${enc(a.external_id)}/media?limit=${i.max ?? 12}&fields=${IG_FIELDS}`);
      return untrusted('Instagram', a, { posts: r.data ?? [] });
    },
  }),
  appTool('instagram', {
    name: 'instagram_comments',
    description: 'Comments (and replies) on one of the user’s Instagram posts (id from instagram_posts).',
    risk: 'read',
    input: z.object({ post_id: z.string().min(3).max(100) }),
    summarize: () => 'Read Instagram comments',
    run: async (i, ctx) => {
      const a = account(ctx, 'instagram', i);
      const r = await api(ctx.services, a, `${GRAPH_FB}/${enc(i.post_id)}/comments?limit=50&fields=${enc('id,text,username,timestamp,replies{id,text,username,timestamp}')}`);
      return untrusted('Instagram', a, { comments: r.data ?? [] });
    },
  }),
  appTool('instagram', {
    name: 'instagram_reply',
    description: 'Reply to a comment on the user’s Instagram post.',
    risk: 'consequential',
    input: z.object({ comment_id: z.string().min(3).max(100), message: z.string().min(1).max(2200) }),
    summarize: (i) => `Reply on Instagram: ${preview(i.message)}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'instagram', i);
      const r = await api(ctx.services, a, `${GRAPH_FB}/${enc(i.comment_id)}/replies`, { body: { message: i.message } });
      return { replied: true, id: r.id };
    },
  }),
  appTool('instagram', {
    name: 'instagram_post_photo',
    description: 'Publish a photo post on the user’s Instagram: a photo they attached in Carino (document id) or a public image link (JPEG), with a caption. Always show the user the caption first.',
    risk: 'consequential',
    input: z.object({ photo_document_id: z.string().max(64).optional(), image_url: z.string().url().max(2000).optional(), caption: z.string().max(2200).optional() }),
    summarize: (i) => `Post a photo on Instagram${i.caption ? `: ${preview(i.caption)}` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'instagram', i);
      if (!i.photo_document_id && !i.image_url) throw new AppError('Attach a photo (or give a public image link) to post on Instagram.');
      const imageUrl = i.photo_document_id ? await publicPhotoUrl(ctx, a, i.photo_document_id) : i.image_url!;
      const c = await api(ctx.services, a, `${GRAPH_FB}/${enc(a.external_id)}/media`, { body: { image_url: imageUrl, caption: i.caption ?? '' } });
      // Instagram processes the photo first; a few quick checks are normally enough.
      for (let n = 0; n < 10; n++) {
        const s = await api(ctx.services, a, `${GRAPH_FB}/${enc(c.id)}?fields=status_code`);
        if (s.status_code === 'FINISHED' || !s.status_code) break;
        if (s.status_code === 'ERROR') throw new AppError('Instagram couldn’t process that photo (it accepts JPEG photos with an aspect ratio between 4:5 and 1.91:1).');
        await new Promise((r) => setTimeout(r, 1500));
      }
      const pub = await api(ctx.services, a, `${GRAPH_FB}/${enc(a.external_id)}/media_publish`, { body: { creation_id: c.id } });
      const media = await api(ctx.services, a, `${GRAPH_FB}/${enc(pub.id)}?fields=permalink`).catch(() => ({}));
      return { posted: true, id: pub.id, link: media.permalink };
    },
  }),

  // ---- TikTok ----
  appTool('tiktok', {
    name: 'tiktok_profile',
    description: 'The user’s TikTok display name.',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'Look at the TikTok profile',
    run: async (i, ctx) => {
      const a = account(ctx, 'tiktok', i);
      const r = await api(ctx.services, a, `${TT_API}/user/info/?fields=open_id,display_name,avatar_url`);
      return untrusted('TikTok', a, r.data?.user ?? {});
    },
  }),
  appTool('tiktok', {
    name: 'tiktok_upload_video',
    description: 'Send a video the user attached in Carino (document id) to their TikTok as a draft. They get a TikTok notification to add sounds, a caption and post it.',
    risk: 'consequential',
    input: z.object({ video_document_id: z.string().min(1).max(64) }),
    summarize: () => 'Send a video to TikTok as a draft',
    run: async (i, ctx) => {
      const a = account(ctx, 'tiktok', i);
      const { doc, buf } = await ownDocument(ctx, i.video_document_id);
      if (doc.kind !== 'video') throw new AppError('That file isn’t a video. TikTok takes MP4, MOV or WebM videos.');
      if (buf.length > MAX_SOCIAL_UPLOAD) throw new AppError('Carino can send videos up to 50 MB to TikTok. Share bigger ones straight from your gallery.');
      const chunks = tiktokChunks(buf.length);
      const init = await tiktok(ctx.services, a, 'post/publish/inbox/video/init/', { source_info: { source: 'FILE_UPLOAD', video_size: buf.length, ...chunks } });
      if (!init.upload_url) throw new AppError('TikTok didn’t accept the upload.');
      const f = ctx.services.netFetch ?? fetch;
      for (let n = 0; n < chunks.total_chunk_count; n++) {
        const start = n * chunks.chunk_size;
        const end = n === chunks.total_chunk_count - 1 ? buf.length : start + chunks.chunk_size;
        const res = await f(init.upload_url, {
          method: 'PUT', body: new Uint8Array(buf.subarray(start, end)),
          headers: { 'content-type': doc.mime || 'video/mp4', 'content-range': `bytes ${start}-${end - 1}/${buf.length}` },
          signal: AbortSignal.timeout(300_000),
        }).catch(() => null);
        if (!res || (res.status !== 201 && res.status !== 206 && !res.ok)) throw new AppError('The video upload to TikTok failed. Try again on a stronger connection.');
      }
      return { sent: true, publish_id: init.publish_id, next: 'Open TikTok: the video is waiting in your notifications (inbox) to finish and post.' };
    },
  }),
];
