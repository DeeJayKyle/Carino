import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { AppLogo, type AppLogoId } from '../components/AppLogo';
import { ErrorBox, Loading, useConfirm, useToast } from '../components/ui';
import { useData } from '../lib/hooks';
import { del, post, put } from '../lib/api';
import { Link, navigate, useLocation } from '../lib/router';
import { openSignIn } from '../../mobile/native';

type Group = 'google' | 'microsoft' | 'meta' | 'x' | 'linkedin' | 'tiktok';
interface AppRow {
  id: string;
  label: string;
  group: Group;
  redirect_uri: string;
  client: { client_id: string; has_secret: boolean } | null;
  needs_secret: boolean;
  accounts: { id: string; label: string; last_error: string | null }[];
}

/** What each app lets Carino do, and the parts shown as chips (like Gmail · Calendar · Drive). */
const ABOUT: Record<string, { name: string; parts?: string[]; does: string[]; beta?: boolean }> = {
  google: { name: 'Google', parts: ['Gmail', 'Calendar', 'Drive', 'Sheets', 'Docs'], does: ['Find, read, draft and send email', 'See and add calendar events (with Meet links)', 'Find and read Drive files; save attachments to Drive', 'Read and fill in Google Sheets; create Sheets and Docs'] },
  microsoft: { name: 'Microsoft', parts: ['Outlook', 'Calendar', 'OneDrive', 'Word', 'Excel', 'PowerPoint'], does: ['Find, read, draft and send Outlook email', 'See and add Outlook calendar events (with Teams links)', 'Find and read OneDrive files', 'Write Word documents, Excel workbooks and PowerPoint decks; read and update Excel'] },
  instagram: { name: 'Instagram', beta: true, does: ['See your profile, posts, likes and comments', 'Reply to comments', 'Post a photo you attach, with a caption'] },
  facebook: { name: 'Facebook', beta: true, does: ['See your Pages’ posts and comments', 'Post to a Page (text, link or photo)', 'Reply to comments as the Page'] },
  x: { name: 'X (Twitter)', beta: true, does: ['Post and reply as you', 'See your profile and recent posts (X’s free plan allows very few reads)'] },
  linkedin: { name: 'LinkedIn', beta: true, does: ['Post as you, with a link if you like'] },
  tiktok: { name: 'TikTok', beta: true, does: ['Send a video you attach to TikTok as a draft, ready for you to finish and post'] },
};

const A = ({ href, children }: { href: string; children: ReactNode }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

/** One-time setup of the user's own (free) developer app at each provider. */
function guide(group: Group, redirect: string): { steps: ReactNode[]; note?: ReactNode; idLabel: string; secretLabel: string } {
  const R = <code className="mono">{redirect}</code>;
  switch (group) {
    case 'google':
      return {
        idLabel: 'Client ID', secretLabel: 'Client secret',
        steps: [
          <>Open <A href="https://console.cloud.google.com/projectcreate">Google Cloud</A> and create a project (any name, e.g. “Carino”). It’s free.</>,
          <>In <A href="https://console.cloud.google.com/apis/library">APIs &amp; Services → Library</A>, turn on <b>Gmail API</b>, <b>Google Calendar API</b>, <b>Google Drive API</b>, <b>Google Sheets API</b> and <b>Google Docs API</b>.</>,
          <>Open <A href="https://console.cloud.google.com/auth/overview">Google Auth Platform</A> → <b>Get started</b>: app name “Carino”, your email, audience <b>External</b>. Then under <b>Audience</b> tap <b>Publish app</b> (otherwise Google signs you out every 7 days).</>,
          <>Under <b>Clients</b> → <b>Create client</b>, choose <b>Desktop app</b>. Copy the <b>Client ID</b> and <b>Client secret</b> here.</>,
        ],
        note: <>When you sign in, Google says the app isn’t verified — that’s expected for your own app. Tap <b>Advanced → Go to Carino</b>. For a second Google account, just sign in again.</>,
      };
    case 'microsoft':
      return {
        idLabel: 'Application (client) ID', secretLabel: '',
        steps: [
          <>Open <A href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">Microsoft Entra → App registrations</A> (free, sign in with your Microsoft account) and tap <b>New registration</b>.</>,
          <>Name it “Carino”. Who can use it: <b>Accounts in any organizational directory and personal Microsoft accounts</b>.</>,
          <>Redirect URI: choose <b>Public client/native (mobile &amp; desktop)</b> and enter {R} Tap <b>Register</b>.</>,
          <>Copy the <b>Application (client) ID</b> here. No secret is needed.</>,
        ],
        note: <>Work or school accounts may need their IT admin to allow the app.</>,
      };
    case 'meta':
      return {
        idLabel: 'App ID', secretLabel: 'App secret',
        steps: [
          <>Open <A href="https://developers.facebook.com/apps/creation/">Meta for Developers → Create app</A> (free). Choose the use cases <b>Manage everything on your Page</b> and <b>Manage messaging &amp; content on Instagram</b>.</>,
          <>In <b>App settings → Basic</b>, copy the <b>App ID</b> and <b>App secret</b> here.</>,
          <>In <b>Facebook Login → Settings</b>, add this to <b>Valid OAuth Redirect URIs</b>: {R}</>,
          <>Leave the app in <b>Development</b> mode: as its admin you can use it without Meta’s review.</>,
        ],
        note: <>Facebook lets apps post to <b>Pages</b> you manage, not your personal profile. Instagram needs a <b>Business or Creator</b> account linked to one of your Pages. One Meta app works for Facebook, Instagram and WhatsApp.</>,
      };
    case 'x':
      return {
        idLabel: 'OAuth 2.0 Client ID', secretLabel: 'Client secret (if shown)',
        steps: [
          <>Open the <A href="https://developer.x.com/en/portal/dashboard">X Developer Portal</A> and sign up for the <b>Free</b> plan.</>,
          <>In your app → <b>User authentication settings → Set up</b>: permissions <b>Read and write</b>, type <b>Native App</b>.</>,
          <>Callback URI: {R} — website: any link of yours.</>,
          <>Under <b>Keys and tokens</b>, copy the <b>OAuth 2.0 Client ID</b> (and secret, if X shows one) here.</>,
        ],
        note: <>X’s free plan allows about 500 posts a month and very few reads.</>,
      };
    case 'linkedin':
      return {
        idLabel: 'Client ID', secretLabel: 'Client secret',
        steps: [
          <>Open <A href="https://www.linkedin.com/developers/apps/new">LinkedIn Developers → Create app</A> (free). LinkedIn asks for a Page to link it to; any Page you manage works.</>,
          <>Under <b>Products</b>, add <b>Sign In with LinkedIn using OpenID Connect</b> and <b>Share on LinkedIn</b>.</>,
          <>Under <b>Auth</b>, add this <b>Authorized redirect URL</b>: {R}</>,
          <>Copy the <b>Client ID</b> and <b>Client secret</b> here.</>,
        ],
        note: <>LinkedIn sign-ins last 60 days; Carino tells you when to sign in again.</>,
      };
    case 'tiktok':
      return {
        idLabel: 'Client key', secretLabel: 'Client secret',
        steps: [
          <>Open <A href="https://developers.tiktok.com/apps/">TikTok for Developers → Manage apps</A> and connect a new app (free).</>,
          <>Add the products <b>Login Kit</b> and <b>Content Posting API</b>. Platform: <b>Desktop</b>. Redirect URI: {R}</>,
          <>Turn on <b>Sandbox</b> and add your TikTok account under <b>Target users</b> (no review needed for your own account).</>,
          <>Copy the <b>Client key</b> and <b>Client secret</b> here.</>,
        ],
        note: <>Videos arrive in your TikTok notifications as drafts; you add the sound and caption and post them yourself.</>,
      };
  }
}

const Dot = ({ ok }: { ok: boolean }) => <span className={`app-dot ${ok ? 'ok' : ''}`} aria-hidden="true" />;

export default function Apps({ id }: { id?: string }) {
  const toast = useToast();
  const { query } = useLocation();
  const apps = useData<{ apps: AppRow[] }>('/apps');
  const chans = useData<any>('/channels');
  const latest = useRef({ apps, chans });
  latest.current = { apps, chans };
  useEffect(() => {
    // A sign-in finished in the browser (see MobileBridge).
    const reload = () => { latest.current.apps.reload(); latest.current.chans.reload(); };
    window.addEventListener('carino-apps-changed', reload);
    return () => window.removeEventListener('carino-apps-changed', reload);
  }, []);
  const connected = query.get('connected');
  const failed = query.get('oauth_error');
  useEffect(() => {
    if (connected) toast(`Connected ${connected}`);
    if (failed) toast(failed, 'error');
  }, [connected, failed, toast]);

  if (apps.loading) return <Shell title="My apps"><Loading /></Shell>;
  if (apps.error) return <Shell title="My apps"><ErrorBox error={apps.error} retry={apps.reload} /></Shell>;
  const list = apps.data!.apps;
  const app = id ? list.find((a) => a.id === id) : undefined;
  if (app) return <AppDetail app={app} reload={apps.reload} />;

  const wa = chans.data?.channels?.find((c: any) => c.kind === 'whatsapp');
  const tg = chans.data?.channels?.find((c: any) => c.kind === 'telegram');
  const order = ['google', 'microsoft', 'instagram', 'facebook', 'x', 'linkedin', 'tiktok'];
  return (
    <Shell title="My apps">
      <div className="page narrow">
        <div className="page-head"><div>
          <h1><Icon name="link" /> My apps</h1>
          <p className="sub">Connect your accounts so Carino can read and act for you. Sending email and posting always waits for your OK.</p>
        </div></div>
        <ul className="app-list" aria-label="Apps">
          <AppItem to="/messaging#whatsapp" logo="whatsapp" name="WhatsApp" beta ok={!!wa?.config?.relay_url && wa.enabled} status={wa?.config?.relay_url ? (wa.enabled ? 'Connected' : 'Turned off') : 'Tap to set up'} />
          {order.map((pid) => {
            const a = list.find((x) => x.id === pid)!;
            const about = ABOUT[pid];
            const n = a.accounts.length;
            return (
              <AppItem key={pid} to={`/apps/${pid}`} logo={pid as AppLogoId} name={about.name} beta={about.beta}
                badge={n > 1 ? `${n} accounts` : undefined} ok={n > 0}
                status={n ? (a.accounts.some((x) => x.last_error) ? 'Needs you to sign in again' : n === 1 ? a.accounts[0].label : 'Connected') : 'Tap to connect'}
                parts={n ? about.parts : undefined} warn={a.accounts.some((x) => x.last_error)} />
            );
          })}
          <AppItem to="/messaging" logo="telegram" name="Telegram" ok={!!tg?.enabled} status={tg ? (tg.enabled ? `Connected · @${tg.config.bot_username}` : 'Turned off') : 'Tap to set up'} />
          <AppItem to="/connectors" logo="more" name="More apps" status="Notion, Linear, GitHub, Zapier and other MCP apps" />
        </ul>
      </div>
    </Shell>
  );
}

function AppItem({ to, logo, name, status, ok, beta, badge, parts, warn }: { to: string; logo: AppLogoId; name: string; status: string; ok?: boolean; beta?: boolean; badge?: string; parts?: string[]; warn?: boolean }) {
  return (
    <li>
      <Link to={to} className="app-item">
        <AppLogo id={logo} size={44} />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="app-name">{name}{beta && <span className="badge">Beta</span>}{badge && <span className="badge">{badge}</span>}</span>
          {parts ? (
            <span className="app-parts">{parts.map((p) => <span key={p} className="chip-sm">{p}</span>)}</span>
          ) : (
            <span className={`app-status ${warn ? 'warn' : ''}`}>{ok !== undefined && <Dot ok={!!ok && !warn} />}<span className="ellipsis">{status}</span></span>
          )}
        </span>
        <Icon name="chevron" size={16} />
      </Link>
    </li>
  );
}

function AppDetail({ app, reload }: { app: AppRow; reload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const about = ABOUT[app.id];
  const g = guide(app.group, app.redirect_uri);
  const [clientId, setClientId] = useState(app.client?.client_id ?? '');
  const [secret, setSecret] = useState(app.client?.has_secret ? '••••••••' : '');
  const [busy, setBusy] = useState(false);
  const shared = app.group === 'meta' ? (app.id === 'facebook' ? 'Instagram' : 'Facebook') : null;

  const signIn = async () => {
    setBusy(true);
    try {
      const r = await post<{ authorize_url: string }>(`/apps/${app.id}/start`);
      const err = openSignIn(r.authorize_url);
      if (err) toast(err, 'error');
      else toast(`Finish signing in to ${about.name} in your browser`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await put(`/apps/clients/${app.group}`, { client_id: clientId.trim(), client_secret: secret.trim() || undefined });
      toast('Saved. Now sign in.');
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title={about.name}>
      <div className="page narrow">
        <button className="btn ghost sm" onClick={() => navigate('/apps')} style={{ marginBottom: 8 }}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} />My apps</button>
        <section className="card pad app-hero">
          <AppLogo id={app.id as AppLogoId} size={56} />
          <div className="grow">
            <h1>{about.name}{about.beta && <span className="badge" style={{ marginLeft: 8 }}>Beta</span>}</h1>
            <ul className="small muted app-does">{about.does.map((d) => <li key={d}>{d}</li>)}</ul>
          </div>
        </section>

        <section className="card pad" style={{ marginTop: 14 }}>
          <h2>Accounts</h2>
          {app.accounts.length ? (
            <ul className="list divided" style={{ marginTop: 6 }}>
              {app.accounts.map((a) => (
                <li key={a.id} className="list-item">
                  <Dot ok={!a.last_error} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="ellipsis" style={{ display: 'block' }}>{a.label}</span>
                    {a.last_error && <span className="tiny" style={{ color: 'var(--danger)' }}>{a.last_error}</span>}
                  </span>
                  {a.last_error && <button className="btn sm" onClick={signIn} disabled={busy}>Sign in again</button>}
                  <button className="btn ghost icon sm" aria-label={`Disconnect ${a.label}`} onClick={async () => {
                    if (!(await confirm({ title: `Disconnect ${a.label}?`, body: `Carino forgets this ${about.name} sign-in. Nothing in your account is changed.`, confirm: 'Disconnect', danger: true }))) return;
                    await del(`/apps/accounts/${a.id}`).catch((e) => toast(e.message, 'error'));
                    reload();
                  }}><Icon name="x" size={14} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="small muted" style={{ marginTop: 4 }}>Not connected yet.</p>}
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy || !app.client} onClick={signIn}>
              <Icon name="lock" size={15} />{app.accounts.length ? `Add another ${about.name} account` : `Sign in with ${about.name}`}
            </button>
            {!app.client && <span className="small muted">First do the one-time setup below.</span>}
          </div>
        </section>

        <details className="card pad" style={{ marginTop: 14 }} open={!app.client}>
          <summary><h2 style={{ display: 'inline' }}>One-time setup</h2> <span className="small muted">· about 5 minutes, free</span></summary>
          <p className="small muted" style={{ marginTop: 8 }}>
            Carino talks to {about.name} directly from your phone, with your own free developer app — nothing goes through anyone else’s server.
            {shared && <> This is the same Meta app as {shared}: set it up once for both.</>}
          </p>
          <ol className="small steps">{g.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {g.note && <div className="callout small" style={{ marginTop: 10 }}><Icon name="info" size={16} /><span>{g.note}</span></div>}
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="redirect">Redirect address</label>
            <div className="row">
              <input id="redirect" className="input mono grow" readOnly value={app.redirect_uri} />
              <button className="btn sm" onClick={() => navigator.clipboard?.writeText(app.redirect_uri).then(() => toast('Copied'), () => undefined)}><Icon name="copy" size={14} />Copy</button>
            </div>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="client-id">{g.idLabel}</label>
            <input id="client-id" className="input mono" autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </div>
          {g.secretLabel && (
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor="client-secret">{g.secretLabel}</label>
              <input id="client-secret" className="input mono" type="password" autoComplete="off" value={secret} onFocus={() => secret.startsWith('••••') && setSecret('')} onChange={(e) => setSecret(e.target.value)} />
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn" disabled={busy || clientId.trim().length < 4 || (app.needs_secret && !secret.trim())} onClick={save}>Save</button>
            {app.client && <button className="btn ghost sm" onClick={async () => {
              if (!(await confirm({ title: 'Remove the developer app?', body: 'Signed-in accounts keep working until their sign-in expires.', confirm: 'Remove', danger: true }))) return;
              await del(`/apps/clients/${app.group}`);
              setClientId('');
              setSecret('');
              reload();
            }}>Remove</button>}
          </div>
        </details>
        <p className="tiny faint" style={{ marginTop: 12 }}>Your sign-ins are stored encrypted on this phone. Carino asks before sending email or posting anything. You can change what it may do on its own in <Link to="/settings#permissions">Settings</Link>.</p>
      </div>
    </Shell>
  );
}
