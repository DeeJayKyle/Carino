import { z } from 'zod';
import type { Services } from '../../context.ts';
import type { Row } from '../../db/index.ts';
import { api, AppError } from './accounts.ts';
import { appTool, account, untrusted, clip, type AppToolDef } from './common.ts';

/**
 * Work and life apps: Slack, Todoist, TickTick, Notion, Linear, GitHub, Withings and Sonos.
 * Reading is free; anything that changes something or speaks for the user asks first (unless the
 * user allowed that tool), and messages to other people always ask.
 */
const enc = encodeURIComponent;
const preview = (t: string, n = 300) => `“${t.slice(0, n)}${t.length > n ? '…' : ''}”`;

// ---- Slack ---------------------------------------------------------------------------------

async function slack(services: Services, a: Row, method: string, params: Record<string, unknown> = {}, post = false) {
  const url = `https://slack.com/api/${method}`;
  const r: any = post
    ? await api(services, a, url, { body: params, headers: { 'content-type': 'application/json; charset=utf-8' } })
    : await api(services, a, `${url}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`);
  if (!r.ok) {
    const why = String(r.error ?? 'unknown_error');
    if (why === 'missing_scope') throw new AppError(`Slack: the token is missing a permission (${r.needed ?? 'see My apps'}). Add it to the Slack app and paste the new token.`);
    if (why === 'invalid_auth' || why === 'token_revoked') throw new AppError('Slack no longer accepts this token. The user should paste a new one in My apps.');
    throw new AppError(`Slack: ${why.replace(/_/g, ' ')}`);
  }
  return r;
}

async function slackChannel(services: Services, a: Row, wanted: string) {
  if (/^[CGD][A-Z0-9]{6,}$/.test(wanted)) return wanted;
  const name = wanted.replace(/^#/, '').toLowerCase();
  const r = await slack(services, a, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000 });
  const hit = (r.channels ?? []).find((c: any) => String(c.name).toLowerCase() === name);
  if (!hit) throw new AppError(`No Slack channel called #${name} that you’re in.`);
  return String(hit.id);
}

// ---- Todoist (API v1) ----------------------------------------------------------------------

const TODOIST = 'https://api.todoist.com/api/v1';

// ---- Notion --------------------------------------------------------------------------------

const NOTION = 'https://api.notion.com/v1';
const notionTitle = (p: any) => {
  for (const v of Object.values<any>(p?.properties ?? {})) if (v?.type === 'title') return (v.title ?? []).map((t: any) => t.plain_text).join('');
  return (p?.title ?? []).map((t: any) => t.plain_text).join('') || 'Untitled';
};
const notionId = (s: string) => {
  const m = s.replace(/-/g, '').match(/([0-9a-f]{32})(?:\?|$)/i);
  if (!m) throw new AppError('Give a Notion page link or id.');
  return m[1];
};
function blockText(b: any): string {
  const v = b?.[b?.type];
  const t = (v?.rich_text ?? []).map((r: any) => r.plain_text).join('');
  switch (b?.type) {
    case 'heading_1': return `# ${t}`;
    case 'heading_2': return `## ${t}`;
    case 'heading_3': return `### ${t}`;
    case 'bulleted_list_item': return `• ${t}`;
    case 'numbered_list_item': return `1. ${t}`;
    case 'to_do': return `${v?.checked ? '☑' : '☐'} ${t}`;
    case 'child_page': return `📄 ${v?.title ?? ''} (page ${b.id})`;
    default: return t;
  }
}
const paragraphs = (text: string) => text.split(/\n{1,}/).filter((l) => l.trim()).slice(0, 90).map((l) => {
  const bullet = l.match(/^\s*[-•*]\s+(.*)/);
  const head = l.match(/^(#{1,3})\s+(.*)/);
  const type = head ? `heading_${head[1].length}` : bullet ? 'bulleted_list_item' : 'paragraph';
  const content = (head?.[2] ?? bullet?.[1] ?? l).slice(0, 1900);
  return { object: 'block', type, [type]: { rich_text: [{ type: 'text', text: { content } }] } };
});

// ---- Linear --------------------------------------------------------------------------------

async function linear(services: Services, a: Row, query: string, variables: Record<string, unknown> = {}) {
  const r: any = await api(services, a, 'https://api.linear.app/graphql', { body: { query, variables } });
  if (r.errors?.length) throw new AppError(`Linear: ${r.errors[0].message}`);
  return r.data;
}

// ---- GitHub --------------------------------------------------------------------------------

const GH = 'https://api.github.com';
const repoRe = /^[\w.-]+\/[\w.-]+$/;

// ---- Withings ------------------------------------------------------------------------------

async function withings(services: Services, a: Row, path: string, params: Record<string, string | number>) {
  const form = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r: any = await api(services, a, `https://wbsapi.withings.net/${path}`, { raw: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (r.status === 401) throw new AppError('Withings says the sign-in is no longer valid. The user should sign in again in My apps.');
  if (r.status !== 0) throw new AppError(`Withings error ${r.status}${r.error ? `: ${r.error}` : ''}`);
  return r.body;
}
const MEAS: Record<number, [string, string]> = {
  1: ['weight', 'kg'], 4: ['height', 'm'], 5: ['fat-free mass', 'kg'], 6: ['body fat', '%'], 8: ['fat mass', 'kg'], 9: ['diastolic blood pressure', 'mmHg'],
  10: ['systolic blood pressure', 'mmHg'], 11: ['heart rate', 'bpm'], 54: ['SpO2', '%'], 71: ['body temperature', '°C'], 76: ['muscle mass', 'kg'], 88: ['bone mass', 'kg'],
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ---- Sonos ---------------------------------------------------------------------------------

const SONOS = 'https://api.ws.sonos.com/control/api/v1';
async function sonosGroups(services: Services, a: Row) {
  const out: { id: string; name: string; state?: string; household: string }[] = [];
  const h: any = await api(services, a, `${SONOS}/households`);
  for (const hh of h.households ?? []) {
    const g: any = await api(services, a, `${SONOS}/households/${enc(hh.id)}/groups`);
    for (const x of g.groups ?? []) out.push({ id: x.id, name: x.name, state: x.playbackState, household: hh.id });
  }
  return out;
}
async function sonosGroup(services: Services, a: Row, room?: string) {
  const all = await sonosGroups(services, a);
  if (!all.length) throw new AppError('No Sonos speakers found.');
  if (!room) {
    if (all.length === 1) return all[0];
    throw new AppError(`Which room? ${all.map((g) => g.name).join(', ')}.`);
  }
  const w = room.toLowerCase();
  const hit = all.find((g) => g.name.toLowerCase() === w) ?? all.find((g) => g.name.toLowerCase().includes(w));
  if (!hit) throw new AppError(`No Sonos room matches “${room}”. Rooms: ${all.map((g) => g.name).join(', ')}.`);
  return hit;
}

export const WORK_TOOLS: AppToolDef[] = [
  // ---- Slack ----
  appTool('slack', {
    name: 'slack_channels',
    description: 'The Slack channels the user is in (names and topics).',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'Look at Slack channels',
    run: async (i, ctx) => {
      const a = account(ctx, 'slack', i);
      const r = await slack(ctx.services, a, 'users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 });
      return untrusted('Slack', a, { channels: (r.channels ?? []).map((c: any) => ({ id: c.id, name: `#${c.name}`, topic: c.topic?.value || undefined })) });
    },
  }),
  appTool('slack', {
    name: 'slack_read_channel',
    description: 'Recent messages in a Slack channel (by #name or id), newest last.',
    risk: 'read',
    input: z.object({ channel: z.string().min(1).max(100), max: z.number().int().min(5).max(100).optional() }),
    summarize: (i) => `Read Slack ${i.channel}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'slack', i);
      const id = await slackChannel(ctx.services, a, i.channel);
      const r = await slack(ctx.services, a, 'conversations.history', { channel: id, limit: i.max ?? 30 });
      const names = new Map<string, string>();
      for (const m of r.messages ?? []) {
        if (m.user && !names.has(m.user)) {
          try { names.set(m.user, (await slack(ctx.services, a, 'users.info', { user: m.user })).user?.real_name ?? m.user); } catch { names.set(m.user, m.user); }
        }
      }
      const messages = (r.messages ?? []).reverse().map((m: any) => ({ from: names.get(m.user) ?? m.username ?? 'bot', at: new Date(Number(m.ts) * 1000).toISOString(), text: clip(String(m.text ?? ''), 2000) }));
      return untrusted('Slack', a, { channel: i.channel, messages });
    },
  }),
  appTool('slack', {
    name: 'slack_search',
    description: 'Search the user’s Slack messages (Slack search syntax, e.g. "from:@ana budget in:#team").',
    risk: 'read',
    input: z.object({ query: z.string().min(1).max(300) }),
    summarize: (i) => `Search Slack for “${i.query}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'slack', i);
      const r = await slack(ctx.services, a, 'search.messages', { query: i.query, count: 20 });
      return untrusted('Slack', a, { results: (r.messages?.matches ?? []).map((m: any) => ({ channel: m.channel?.name ? `#${m.channel.name}` : undefined, from: m.username, at: new Date(Number(m.ts) * 1000).toISOString(), text: clip(String(m.text ?? ''), 1000), link: m.permalink })) });
    },
  }),
  appTool('slack', {
    name: 'slack_send',
    description: 'Send a Slack message as the user to a channel (#name or id), optionally in a thread. Show the user the exact text first.',
    risk: 'consequential',
    input: z.object({ channel: z.string().min(1).max(100), text: z.string().min(1).max(8000), thread_ts: z.string().regex(/^\d+\.\d+$/).optional() }),
    summarize: (i) => `Send to Slack ${i.channel}: ${preview(i.text)}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'slack', i);
      const r = await slack(ctx.services, a, 'chat.postMessage', { channel: await slackChannel(ctx.services, a, i.channel), text: i.text, thread_ts: i.thread_ts }, true);
      return { sent: true, ts: r.ts };
    },
  }),

  // ---- Todoist ----
  appTool('todoist', {
    name: 'todoist_tasks',
    description: 'Open Todoist tasks, optionally only those matching a Todoist filter such as "today", "overdue" or "#Work".',
    risk: 'read',
    input: z.object({ filter: z.string().max(200).optional() }),
    summarize: (i) => `Look at Todoist tasks${i.filter ? ` (${i.filter})` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'todoist', i);
      const r: any = i.filter
        ? await api(ctx.services, a, `${TODOIST}/tasks/filter?query=${enc(i.filter)}&limit=100`)
        : await api(ctx.services, a, `${TODOIST}/tasks?limit=100`);
      return untrusted('Todoist', a, { tasks: (r.results ?? r ?? []).map((t: any) => ({ id: t.id, content: t.content, due: t.due?.string ?? t.due?.date, priority: t.priority, project_id: t.project_id })) });
    },
  }),
  appTool('todoist', {
    name: 'todoist_add_task',
    description: 'Add a task to Todoist. "due" takes Todoist’s natural language ("tomorrow 9am", "every Monday").',
    risk: 'reversible',
    input: z.object({ content: z.string().min(1).max(500), due: z.string().max(100).optional(), priority: z.number().int().min(1).max(4).optional().describe('4 is most urgent'), description: z.string().max(2000).optional() }),
    summarize: (i) => `Add to Todoist: ${preview(i.content, 120)}${i.due ? ` (${i.due})` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'todoist', i);
      const t: any = await api(ctx.services, a, `${TODOIST}/tasks`, { body: { content: i.content, due_string: i.due, priority: i.priority, description: i.description } });
      return { added: true, id: t.id, due: t.due?.string };
    },
  }),
  appTool('todoist', {
    name: 'todoist_complete_task',
    description: 'Mark a Todoist task done (by id from todoist_tasks).',
    risk: 'reversible',
    input: z.object({ task_id: z.string().regex(/^\w{1,40}$/) }),
    summarize: (i) => `Complete Todoist task ${i.task_id}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'todoist', i);
      await api(ctx.services, a, `${TODOIST}/tasks/${enc(i.task_id)}/close`, { method: 'POST' });
      return { completed: true };
    },
  }),

  // ---- TickTick ----
  appTool('ticktick', {
    name: 'ticktick_tasks',
    description: 'Open TickTick tasks, by list.',
    risk: 'read',
    input: z.object({ list: z.string().max(100).optional().describe('Only this list (name)') }),
    summarize: () => 'Look at TickTick tasks',
    run: async (i, ctx) => {
      const a = account(ctx, 'ticktick', i);
      const projects: any[] = await api(ctx.services, a, 'https://api.ticktick.com/open/v1/project');
      const pick = i.list ? projects.filter((p) => String(p.name).toLowerCase().includes(i.list!.toLowerCase())) : projects;
      const lists = [];
      for (const p of [{ id: 'inbox', name: 'Inbox' }, ...pick].slice(0, 15)) {
        try {
          const d: any = await api(ctx.services, a, `https://api.ticktick.com/open/v1/project/${enc(p.id)}/data`);
          lists.push({ list: p.name, list_id: p.id, tasks: (d.tasks ?? []).filter((t: any) => t.status === 0).map((t: any) => ({ id: t.id, title: t.title, due: t.dueDate, priority: t.priority })) });
        } catch { /* a list it can't open */ }
      }
      return untrusted('TickTick', a, { lists });
    },
  }),
  appTool('ticktick', {
    name: 'ticktick_add_task',
    description: 'Add a task to TickTick (to the inbox unless a list id is given).',
    risk: 'reversible',
    input: z.object({ title: z.string().min(1).max(500), due_iso: z.string().max(40).optional().describe('ISO date-time with offset'), list_id: z.string().max(60).optional(), content: z.string().max(2000).optional() }),
    summarize: (i) => `Add to TickTick: ${preview(i.title, 120)}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'ticktick', i);
      const due = i.due_iso ? new Date(i.due_iso) : null;
      if (due && isNaN(due.getTime())) throw new AppError('That due date isn’t valid.');
      const t: any = await api(ctx.services, a, 'https://api.ticktick.com/open/v1/task', {
        body: { title: i.title, content: i.content, projectId: i.list_id, dueDate: due ? due.toISOString().replace('Z', '+0000') : undefined },
      });
      return { added: true, id: t.id };
    },
  }),
  appTool('ticktick', {
    name: 'ticktick_complete_task',
    description: 'Mark a TickTick task done (ids from ticktick_tasks).',
    risk: 'reversible',
    input: z.object({ list_id: z.string().max(60), task_id: z.string().max(60) }),
    summarize: (i) => `Complete TickTick task ${i.task_id}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'ticktick', i);
      await api(ctx.services, a, `https://api.ticktick.com/open/v1/project/${enc(i.list_id)}/task/${enc(i.task_id)}/complete`, { method: 'POST' });
      return { completed: true };
    },
  }),

  // ---- Notion ----
  appTool('notion', {
    name: 'notion_search',
    description: 'Search the Notion pages shared with Carino, by title.',
    risk: 'read',
    input: z.object({ query: z.string().max(200) }),
    summarize: (i) => `Search Notion for “${i.query}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'notion', i);
      const r: any = await api(ctx.services, a, `${NOTION}/search`, { body: { query: i.query, page_size: 20 } });
      return untrusted('Notion', a, { results: (r.results ?? []).map((p: any) => ({ id: p.id, type: p.object, title: notionTitle(p), url: p.url, edited: p.last_edited_time })) });
    },
  }),
  appTool('notion', {
    name: 'notion_read_page',
    description: 'Read a Notion page’s text (by link or id).',
    risk: 'read',
    input: z.object({ page: z.string().min(8).max(300) }),
    summarize: () => 'Read a Notion page',
    run: async (i, ctx) => {
      const a = account(ctx, 'notion', i);
      const id = notionId(i.page);
      const page: any = await api(ctx.services, a, `${NOTION}/pages/${id}`);
      const lines: string[] = [];
      let cursor: string | undefined;
      for (let n = 0; n < 5; n++) {
        const r: any = await api(ctx.services, a, `${NOTION}/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${enc(cursor)}` : ''}`);
        lines.push(...(r.results ?? []).map(blockText).filter(Boolean));
        if (!r.has_more) break;
        cursor = r.next_cursor;
      }
      return untrusted('Notion', a, { title: notionTitle(page), url: page.url, text: clip(lines.join('\n')) });
    },
  }),
  appTool('notion', {
    name: 'notion_create_page',
    description: 'Create a Notion page inside a page shared with Carino. Text lines become paragraphs; "- " lines bullets; "# " lines headings.',
    risk: 'reversible',
    input: z.object({ parent: z.string().min(8).max(300).describe('Parent page link or id'), title: z.string().min(1).max(200), text: z.string().max(20000).optional() }),
    summarize: (i) => `Create Notion page “${i.title}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'notion', i);
      const p: any = await api(ctx.services, a, `${NOTION}/pages`, {
        body: { parent: { page_id: notionId(i.parent) }, properties: { title: { title: [{ text: { content: i.title } }] } }, children: i.text ? paragraphs(i.text) : [] },
      });
      return { created: true, url: p.url };
    },
  }),
  appTool('notion', {
    name: 'notion_append',
    description: 'Add text to the end of a Notion page.',
    risk: 'reversible',
    input: z.object({ page: z.string().min(8).max(300), text: z.string().min(1).max(20000) }),
    summarize: (i) => `Add to a Notion page: ${preview(i.text, 120)}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'notion', i);
      await api(ctx.services, a, `${NOTION}/blocks/${notionId(i.page)}/children`, { method: 'PATCH', body: { children: paragraphs(i.text) } });
      return { added: true };
    },
  }),

  // ---- Linear ----
  appTool('linear', {
    name: 'linear_my_issues',
    description: 'Linear issues assigned to the user that aren’t done.',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'Look at my Linear issues',
    run: async (i, ctx) => {
      const a = account(ctx, 'linear', i);
      const d = await linear(ctx.services, a, `{ viewer { assignedIssues(first: 50, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title url priorityLabel dueDate state { name } team { key } } } } }`);
      return untrusted('Linear', a, { issues: d.viewer.assignedIssues.nodes });
    },
  }),
  appTool('linear', {
    name: 'linear_create_issue',
    description: 'Create a Linear issue in a team (by team key, e.g. "ENG"; leave out if the user has one team).',
    risk: 'reversible',
    input: z.object({ title: z.string().min(1).max(250), description: z.string().max(10000).optional(), team: z.string().max(20).optional(), assign_to_me: z.boolean().optional() }),
    summarize: (i) => `Create Linear issue “${i.title}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'linear', i);
      const d = await linear(ctx.services, a, '{ viewer { id } teams(first: 50) { nodes { id key name } } }');
      const teams = d.teams.nodes as { id: string; key: string; name: string }[];
      const team = i.team ? teams.find((t) => t.key.toLowerCase() === i.team!.toLowerCase() || t.name.toLowerCase() === i.team!.toLowerCase()) : teams.length === 1 ? teams[0] : undefined;
      if (!team) throw new AppError(`Which team? ${teams.map((t) => `${t.key} (${t.name})`).join(', ')}.`);
      const r = await linear(ctx.services, a, 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }', {
        input: { teamId: team.id, title: i.title, description: i.description, assigneeId: i.assign_to_me ? d.viewer.id : undefined },
      });
      return { created: true, ...r.issueCreate.issue };
    },
  }),
  appTool('linear', {
    name: 'linear_comment',
    description: 'Comment on a Linear issue (by identifier like ENG-123).',
    risk: 'consequential',
    input: z.object({ issue: z.string().regex(/^[A-Za-z]{1,10}-\d{1,7}$/), text: z.string().min(1).max(10000) }),
    summarize: (i) => `Comment on ${i.issue}: ${preview(i.text)}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'linear', i);
      const d = await linear(ctx.services, a, 'query($id: String!) { issue(id: $id) { id } }', { id: i.issue.toUpperCase() });
      await linear(ctx.services, a, 'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId: d.issue.id, body: i.text } });
      return { commented: true };
    },
  }),

  // ---- GitHub ----
  appTool('github', {
    name: 'github_inbox',
    description: 'The user’s GitHub notifications, and open issues and pull requests assigned to them or waiting for their review.',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'Look at GitHub',
    run: async (i, ctx) => {
      const a = account(ctx, 'github', i);
      const login = String(a.label).replace(/^@/, '');
      const [notes, assigned, reviews] = await Promise.all([
        api(ctx.services, a, `${GH}/notifications?per_page=30`).catch(() => []),
        api(ctx.services, a, `${GH}/search/issues?q=${enc(`is:open assignee:${login} archived:false`)}&per_page=30`),
        api(ctx.services, a, `${GH}/search/issues?q=${enc(`is:open is:pr review-requested:${login} archived:false`)}&per_page=30`),
      ]);
      const item = (x: any) => ({ title: x.title, url: x.html_url, repo: String(x.repository_url ?? '').split('/repos/')[1], number: x.number, updated: x.updated_at });
      return untrusted('GitHub', a, {
        notifications: (notes as any[]).map((n) => ({ reason: n.reason, title: n.subject?.title, type: n.subject?.type, repo: n.repository?.full_name, updated: n.updated_at })),
        assigned: (assigned as any).items?.map(item) ?? [],
        review_requested: (reviews as any).items?.map(item) ?? [],
      });
    },
  }),
  appTool('github', {
    name: 'github_read_issue',
    description: 'Read a GitHub issue or pull request with its latest comments.',
    risk: 'read',
    input: z.object({ repo: z.string().regex(repoRe).describe('owner/name'), number: z.number().int().positive() }),
    summarize: (i) => `Read ${i.repo}#${i.number}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'github', i);
      const [issue, comments]: any[] = await Promise.all([
        api(ctx.services, a, `${GH}/repos/${i.repo}/issues/${i.number}`),
        api(ctx.services, a, `${GH}/repos/${i.repo}/issues/${i.number}/comments?per_page=30`),
      ]);
      return untrusted('GitHub', a, {
        title: issue.title, state: issue.state, author: issue.user?.login, url: issue.html_url, body: clip(String(issue.body ?? ''), 8000),
        comments: comments.slice(-20).map((c: any) => ({ author: c.user?.login, at: c.created_at, text: clip(String(c.body ?? ''), 2000) })),
      });
    },
  }),
  appTool('github', {
    name: 'github_create_issue',
    description: 'Open an issue in a GitHub repository.',
    risk: 'consequential',
    input: z.object({ repo: z.string().regex(repoRe), title: z.string().min(1).max(250), body: z.string().max(20000).optional() }),
    summarize: (i) => `Open an issue in ${i.repo}: “${i.title}”`,
    run: async (i, ctx) => {
      const a = account(ctx, 'github', i);
      const r: any = await api(ctx.services, a, `${GH}/repos/${i.repo}/issues`, { body: { title: i.title, body: i.body } });
      return { created: true, url: r.html_url, number: r.number };
    },
  }),
  appTool('github', {
    name: 'github_comment',
    description: 'Comment on a GitHub issue or pull request.',
    risk: 'consequential',
    input: z.object({ repo: z.string().regex(repoRe), number: z.number().int().positive(), text: z.string().min(1).max(20000) }),
    summarize: (i) => `Comment on ${i.repo}#${i.number}: ${preview(i.text)}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'github', i);
      const r: any = await api(ctx.services, a, `${GH}/repos/${i.repo}/issues/${i.number}/comments`, { body: { body: i.text } });
      return { commented: true, url: r.html_url };
    },
  }),

  // ---- Withings ----
  appTool('withings', {
    name: 'withings_health',
    description: 'The user’s Withings health data for recent days: body measurements (weight, body fat, blood pressure, heart rate…), daily activity (steps, distance, calories) and sleep.',
    risk: 'read',
    input: z.object({ days: z.number().int().min(1).max(90).optional() }),
    summarize: () => 'Look at Withings health data',
    run: async (i, ctx) => {
      const a = account(ctx, 'withings', i);
      const days = i.days ?? 14;
      const end = ctx.services.now();
      const start = new Date(end.getTime() - days * 86400_000);
      const [meas, act, sleep] = await Promise.all([
        withings(ctx.services, a, 'measure', { action: 'getmeas', meastypes: Object.keys(MEAS).join(','), category: 1, startdate: Math.floor(start.getTime() / 1000), enddate: Math.floor(end.getTime() / 1000) }),
        withings(ctx.services, a, 'v2/measure', { action: 'getactivity', startdateymd: ymd(start), enddateymd: ymd(end), data_fields: 'steps,distance,calories,active' }).catch(() => ({ activities: [] })),
        withings(ctx.services, a, 'v2/sleep', { action: 'getsummary', startdateymd: ymd(start), enddateymd: ymd(end), data_fields: 'total_sleep_time,sleep_score,wakeupcount,hr_average' }).catch(() => ({ series: [] })),
      ]);
      const measurements = (meas.measuregrps ?? []).flatMap((g: any) => (g.measures ?? []).filter((m: any) => MEAS[m.type]).map((m: any) => ({
        at: new Date(g.date * 1000).toISOString(), what: MEAS[m.type][0], value: Math.round(m.value * 10 ** m.unit * 100) / 100, unit: MEAS[m.type][1],
      })));
      return {
        measurements: measurements.slice(0, 200),
        activity: (act.activities ?? []).map((d: any) => ({ date: d.date, steps: d.steps, distance_km: d.distance ? Math.round(d.distance / 10) / 100 : undefined, calories: d.calories })),
        sleep: (sleep.series ?? []).map((s: any) => ({ date: s.date, hours: s.data?.total_sleep_time ? Math.round(s.data.total_sleep_time / 36) / 100 : undefined, score: s.data?.sleep_score, wake_ups: s.data?.wakeupcount, avg_heart_rate: s.data?.hr_average })),
        note: 'Health data from the user’s own devices. Don’t diagnose; suggest a doctor for anything worrying.',
      };
    },
  }),

  // ---- Sonos ----
  appTool('sonos', {
    name: 'sonos_rooms',
    description: 'The user’s Sonos rooms and whether each is playing.',
    risk: 'read',
    input: z.object({}),
    summarize: () => 'Look at Sonos rooms',
    run: async (i, ctx) => {
      const a = account(ctx, 'sonos', i);
      return { rooms: (await sonosGroups(ctx.services, a)).map((g) => ({ room: g.name, state: g.state?.replace('PLAYBACK_STATE_', '').toLowerCase() })) };
    },
  }),
  appTool('sonos', {
    name: 'sonos_control',
    description: 'Control Sonos in a room: play, pause, next, previous, or set the volume (0–100).',
    risk: 'reversible',
    input: z.object({ room: z.string().max(80).optional(), action: z.enum(['play', 'pause', 'next', 'previous', 'volume']), volume: z.number().int().min(0).max(100).optional() }),
    summarize: (i) => `Sonos${i.room ? ` in ${i.room}` : ''}: ${i.action}${i.action === 'volume' ? ` ${i.volume}` : ''}`,
    run: async (i, ctx) => {
      const a = account(ctx, 'sonos', i);
      const g = await sonosGroup(ctx.services, a, i.room);
      if (i.action === 'volume') {
        if (i.volume === undefined) throw new AppError('Say what volume (0–100).');
        await api(ctx.services, a, `${SONOS}/groups/${enc(g.id)}/groupVolume`, { body: { volume: i.volume } });
      } else {
        const path = { play: 'play', pause: 'pause', next: 'skipToNextTrack', previous: 'skipToPreviousTrack' }[i.action];
        await api(ctx.services, a, `${SONOS}/groups/${enc(g.id)}/playback/${path}`, { method: 'POST', body: {} });
      }
      return { done: true, room: g.name };
    },
  }),
];
