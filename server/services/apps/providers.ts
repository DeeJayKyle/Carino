/**
 * The apps Carino signs in to directly (My apps). Each person registers their own free developer
 * app with the provider once and pastes its client id (and secret) into Carino, so nothing goes
 * through a Carino server and no provider review is needed for personal use.
 */
export type ProviderId = 'google' | 'microsoft' | 'facebook' | 'instagram' | 'x' | 'linkedin' | 'tiktok'
  | 'slack' | 'todoist' | 'notion' | 'linear' | 'github' | 'ticktick' | 'withings' | 'sonos';
/** Providers that share one developer app (Facebook and Instagram both use a Meta app). */
export type ClientGroup = 'google' | 'microsoft' | 'meta' | 'x' | 'linkedin' | 'tiktok' | 'ticktick' | 'withings' | 'sonos'
  | 'slack' | 'todoist' | 'notion' | 'linear' | 'github';

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  /** Milliseconds since the epoch. */
  expires_at?: number;
  /** Signed in with one tap through Carino's sign-in helper (it renews these too). */
  managed?: boolean;
  /** Extra fields from the token reply that identify() may need (only during sign-in). */
  reply?: Record<string, unknown>;
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
  identify: (f: AppFetch, token: string, reply?: any) => Promise<{ id: string; label: string }>;
  /** Microsoft asks for the permissions again when refreshing. */
  refreshWithScope?: boolean;
  /**
   * Connected by pasting a personal token instead of signing in (Slack, Todoist, Notion, Linear,
   * GitHub): where to make one, and what it looks like.
   */
  key?: { url: string; steps: string; placeholder: string; pattern?: RegExp };
  /** How the token goes on each request (default: Authorization: Bearer). */
  authHeaders?: (token: string) => Record<string, string>;
  /** Extra fields on every token request (Withings wants action=requesttoken). */
  tokenParams?: Record<string, string>;
  /** Some providers wrap the token reply (Withings: { status, body }). */
  unwrapToken?: (d: any) => any;
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
  // ---- Work and life apps ------------------------------------------------------------------
  slack: {
    id: 'slack', label: 'Slack', group: 'slack', authorize: '', token: '', scopes: [], pkce: 'none', secret: 'none', loopbackHost: 'localhost',
    key: {
      url: 'https://api.slack.com/apps',
      steps: 'Create an app “from scratch” in your workspace, add the User Token Scopes channels:read, channels:history, groups:read, groups:history, im:history, search:read, users:read and chat:write, install it, then copy the User OAuth Token (starts with xoxp-).',
      placeholder: 'xoxp-…', pattern: /^xox[pb]-[\w-]{20,}$/,
    },
    identify: async (f, token) => {
      const r = await getJson(f, 'https://slack.com/api/auth.test', token);
      if (!r.ok) throw new Error(r.error ?? 'Slack didn’t accept that token');
      return { id: `${r.team_id}:${r.user_id}`, label: `${r.user ?? 'you'} @ ${r.team ?? 'Slack'}` };
    },
  },
  todoist: {
    id: 'todoist', label: 'Todoist', group: 'todoist', authorize: '', token: '', scopes: [], pkce: 'none', secret: 'none', loopbackHost: 'localhost',
    key: { url: 'https://app.todoist.com/app/settings/integrations/developer', steps: 'In Todoist open Settings → Integrations → Developer and copy your API token.', placeholder: 'API token', pattern: /^[0-9a-f]{40}$/i },
    identify: async (f, token) => {
      const me = await getJson(f, 'https://api.todoist.com/api/v1/user', token);
      return { id: String(me.id), label: String(me.email ?? me.full_name ?? 'Todoist') };
    },
  },
  notion: {
    id: 'notion', label: 'Notion', group: 'notion', authorize: '', token: '', scopes: [], pkce: 'none', secret: 'none', loopbackHost: 'localhost',
    key: {
      url: 'https://www.notion.so/profile/integrations',
      steps: 'Create an internal integration, copy its secret, then in Notion share the pages Carino may use with it (••• → Connections).',
      placeholder: 'ntn_… or secret_…', pattern: /^(ntn_|secret_)\w{20,}$/,
    },
    authHeaders: (t) => ({ authorization: `Bearer ${t}`, 'notion-version': '2022-06-28' }),
    identify: async (f, token) => {
      const me = await getJson(f, 'https://api.notion.com/v1/users/me', token, { 'notion-version': '2022-06-28' });
      return { id: String(me.bot?.workspace_name ?? me.id), label: String(me.bot?.workspace_name ?? me.name ?? 'Notion') };
    },
  },
  linear: {
    id: 'linear', label: 'Linear', group: 'linear', authorize: '', token: '', scopes: [], pkce: 'none', secret: 'none', loopbackHost: 'localhost',
    key: { url: 'https://linear.app/settings/account/security', steps: 'In Linear open Settings → Security & access → Personal API keys and create a key.', placeholder: 'lin_api_…', pattern: /^lin_api_\w{20,}$/ },
    // Personal keys go in Authorization as they are, without "Bearer".
    authHeaders: (t) => ({ authorization: t }),
    identify: async (f, token) => {
      const res = await f('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: token, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ viewer { id email name } }' }), signal: AbortSignal.timeout(20_000) });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok || !d.data?.viewer) throw new Error(d.errors?.[0]?.message ?? `error ${res.status}`);
      return { id: String(d.data.viewer.id), label: String(d.data.viewer.email ?? d.data.viewer.name) };
    },
  },
  github: {
    id: 'github', label: 'GitHub', group: 'github', authorize: '', token: '', scopes: [], pkce: 'none', secret: 'none', loopbackHost: 'localhost',
    key: {
      url: 'https://github.com/settings/personal-access-tokens/new',
      steps: 'Create a fine-grained personal access token for the repositories Carino may use, with read access to issues and pull requests (and write access to issues if Carino may open or comment on them).',
      placeholder: 'github_pat_… or ghp_…', pattern: /^(github_pat_|ghp_)\w{20,}$/,
    },
    authHeaders: (t) => ({ authorization: `Bearer ${t}`, 'x-github-api-version': '2022-11-28' }),
    identify: async (f, token) => {
      const me = await getJson(f, 'https://api.github.com/user', token);
      return { id: String(me.id), label: `@${me.login}` };
    },
  },
  ticktick: {
    id: 'ticktick', label: 'TickTick', group: 'ticktick',
    authorize: 'https://ticktick.com/oauth/authorize', token: 'https://ticktick.com/oauth/token',
    scopes: ['tasks:read', 'tasks:write'], pkce: 'none', secret: 'required', basicAuth: true, loopbackHost: 'localhost',
    identify: async (f, token) => {
      // TickTick has no "who am I"; one account per person is enough.
      await getJson(f, 'https://api.ticktick.com/open/v1/project', token);
      return { id: 'ticktick', label: 'TickTick' };
    },
  },
  withings: {
    id: 'withings', label: 'Withings', group: 'withings',
    authorize: 'https://account.withings.com/oauth2_user/authorize2', token: 'https://wbsapi.withings.net/v2/oauth2',
    scopes: ['user.info', 'user.metrics', 'user.activity'], scopeSeparator: ',', pkce: 'none', secret: 'required', loopbackHost: 'localhost',
    tokenParams: { action: 'requesttoken' },
    unwrapToken: (d) => (d && typeof d.status === 'number' ? (d.status === 0 ? d.body : { error: d.error ?? `status ${d.status}` }) : d),
    identify: async (_f, _token, reply) => ({ id: String(reply?.userid ?? 'withings'), label: 'Withings' }),
  },
  sonos: {
    id: 'sonos', label: 'Sonos', group: 'sonos',
    authorize: 'https://api.sonos.com/login/v3/oauth', token: 'https://api.sonos.com/login/v3/oauth/access',
    scopes: ['playback-control-all'], pkce: 'none', secret: 'required', basicAuth: true, loopbackHost: 'localhost',
    identify: async (f, token) => {
      const h = await getJson(f, 'https://api.ws.sonos.com/control/api/v1/households', token);
      const id = h.households?.[0]?.id;
      if (!id) throw new Error('No Sonos household found on this account.');
      return { id: String(id), label: h.households.length > 1 ? `Sonos (${h.households.length} homes)` : 'Sonos' };
    },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProvider = (v: string): v is ProviderId => v in PROVIDERS;

/** The port the phone app listens on (loopback only) to catch the sign-in redirect. */
export const LOOPBACK_PORT = 47823;
