/**
 * The apps Carino signs in to directly (My apps). Each person registers their own free developer
 * app with the provider once and pastes its client id (and secret) into Carino, so nothing goes
 * through a Carino server and no provider review is needed for personal use.
 */
export type ProviderId = 'google' | 'microsoft' | 'facebook' | 'instagram' | 'x' | 'linkedin' | 'tiktok';
/** Providers that share one developer app (Facebook and Instagram both use a Meta app). */
export type ClientGroup = 'google' | 'microsoft' | 'meta' | 'x' | 'linkedin' | 'tiktok';

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  /** Milliseconds since the epoch. */
  expires_at?: number;
  /** Signed in with one tap through Carino's sign-in helper (it renews these too). */
  managed?: boolean;
}

export type AppFetch = typeof fetch;

export interface ProviderDef {
  id: ProviderId;
  label: string;
  group: ClientGroup;
  authorize: string;
  token: string;
  scopes: string[];
  scopeSeparator?: string;
  /** TikTok's desktop flow wants the PKCE challenge hex-encoded instead of base64url. */
  pkce: 'S256' | 'S256-hex' | 'none';
  secret: 'required' | 'optional' | 'none';
  /** TikTok calls the client id "client_key". */
  clientParam?: string;
  /** X wants confidential clients to authenticate with HTTP Basic. */
  basicAuth?: boolean;
  /** The loopback host the provider accepts in a redirect address. */
  loopbackHost: 'localhost' | '127.0.0.1';
  extraAuth?: Record<string, string>;
  /** Who signed in: a stable id and a label (email or handle). */
  identify: (f: AppFetch, token: string) => Promise<{ id: string; label: string }>;
  /** Microsoft asks for the permissions again when refreshing. */
  refreshWithScope?: boolean;
  /** Meta: swap the short-lived token for a 60-day one. */
  afterToken?: (f: AppFetch, t: TokenSet, client: { id: string; secret?: string }) => Promise<TokenSet>;
}

export const GRAPH_FB = 'https://graph.facebook.com/v23.0';

async function getJson(f: AppFetch, url: string, token: string, headers: Record<string, string> = {}) {
  const res = await f(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error_description ?? data?.detail ?? `error ${res.status}`);
  return data;
}

const metaLongLived: ProviderDef['afterToken'] = async (f, t, client) => {
  const u = new URL(`${GRAPH_FB}/oauth/access_token`);
  u.search = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: client.id, client_secret: client.secret ?? '', fb_exchange_token: t.access_token }).toString();
  const res = await f(u.href, { signal: AbortSignal.timeout(20_000) });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) return t;
  return { access_token: d.access_token, expires_at: d.expires_in ? Date.now() + d.expires_in * 1000 : t.expires_at };
};

const metaIdentify: ProviderDef['identify'] = async (f, token) => {
  const me = await getJson(f, `${GRAPH_FB}/me?fields=id,name`, token);
  return { id: String(me.id), label: String(me.name ?? me.id) };
};

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  google: {
    id: 'google', label: 'Google', group: 'google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid', 'email', 'profile',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/documents',
    ],
    pkce: 'S256', secret: 'required', loopbackHost: '127.0.0.1',
    // A refresh token every time, and a choice of account (for a second Google account).
    extraAuth: { access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true' },
    identify: async (f, token) => {
      const me = await getJson(f, 'https://openidconnect.googleapis.com/v1/userinfo', token);
      return { id: String(me.sub), label: String(me.email ?? me.name ?? me.sub) };
    },
  },
  microsoft: {
    id: 'microsoft', label: 'Microsoft', group: 'microsoft',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['offline_access', 'openid', 'email', 'profile', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'Files.ReadWrite.All'],
    pkce: 'S256', secret: 'none', loopbackHost: 'localhost', refreshWithScope: true,
    extraAuth: { prompt: 'select_account' },
    identify: async (f, token) => {
      const me = await getJson(f, 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName', token);
      return { id: String(me.id), label: String(me.mail ?? me.userPrincipalName ?? me.displayName ?? me.id) };
    },
  },
  facebook: {
    id: 'facebook', label: 'Facebook', group: 'meta',
    authorize: 'https://www.facebook.com/v23.0/dialog/oauth',
    token: `${GRAPH_FB}/oauth/access_token`,
    scopes: ['public_profile', 'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement', 'pages_read_user_content'],
    scopeSeparator: ',', pkce: 'none', secret: 'required', loopbackHost: 'localhost',
    identify: metaIdentify, afterToken: metaLongLived,
  },
  instagram: {
    id: 'instagram', label: 'Instagram', group: 'meta',
    authorize: 'https://www.facebook.com/v23.0/dialog/oauth',
    token: `${GRAPH_FB}/oauth/access_token`,
    // Instagram professional accounts are reached through the Facebook Page they're linked to.
    // pages_manage_posts: a photo is staged (unpublished) on the linked Page to give Instagram a web address for it.
    scopes: ['public_profile', 'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments'],
    scopeSeparator: ',', pkce: 'none', secret: 'required', loopbackHost: 'localhost',
    identify: async (f, token) => {
      const pages = await getJson(f, `${GRAPH_FB}/me/accounts?fields=instagram_business_account{id,username}&limit=50`, token);
      const ig = (pages.data ?? []).map((p: any) => p.instagram_business_account).find(Boolean);
      if (!ig) throw new Error('No Instagram professional account is linked to your Facebook Pages. In Instagram, switch to a Business or Creator account and link it to a Facebook Page, then sign in again.');
      return { id: String(ig.id), label: `@${ig.username ?? ig.id}` };
    },
    afterToken: metaLongLived,
  },
  x: {
    id: 'x', label: 'X (Twitter)', group: 'x',
    authorize: 'https://x.com/i/oauth2/authorize',
    token: 'https://api.x.com/2/oauth2/token',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    pkce: 'S256', secret: 'optional', basicAuth: true, loopbackHost: '127.0.0.1',
    identify: async (f, token) => {
      const me = await getJson(f, 'https://api.x.com/2/users/me', token);
      return { id: String(me.data?.id), label: `@${me.data?.username ?? me.data?.id}` };
    },
  },
  linkedin: {
    id: 'linkedin', label: 'LinkedIn', group: 'linkedin',
    authorize: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['openid', 'profile', 'email', 'w_member_social'],
    pkce: 'none', secret: 'required', loopbackHost: 'localhost',
    identify: async (f, token) => {
      const me = await getJson(f, 'https://api.linkedin.com/v2/userinfo', token);
      return { id: String(me.sub), label: String(me.email ?? me.name ?? me.sub) };
    },
  },
  tiktok: {
    id: 'tiktok', label: 'TikTok', group: 'tiktok',
    authorize: 'https://www.tiktok.com/v2/auth/authorize/',
    token: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['user.info.basic', 'video.upload'],
    scopeSeparator: ',', pkce: 'S256-hex', secret: 'required', clientParam: 'client_key', loopbackHost: 'localhost',
    identify: async (f, token) => {
      const me = await getJson(f, 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', token);
      return { id: String(me.data?.user?.open_id), label: String(me.data?.user?.display_name ?? 'TikTok') };
    },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProvider = (v: string): v is ProviderId => v in PROVIDERS;

/** The port the phone app listens on (loopback only) to catch the sign-in redirect. */
export const LOOPBACK_PORT = 47823;
