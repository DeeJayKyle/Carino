import { t } from '../lib/i18n';
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
  /** Carino's own app at this provider is ready: just sign in. */
  one_tap: boolean;
  accounts: { id: string; label: string; last_error: string | null }[];
  /** Connected by pasting a personal token. */
  key: { url: string; steps: string; placeholder: string } | null;
}

const KEY_APPS: Record<string, { name: string; color: string; mark: string; does: string[] }> = {
  slack: { name: 'Slack', color: '#4A154B', mark: '#', does: ['Read channels and search messages', 'Send a message or thread reply as you (after your OK)'] },
  todoist: { name: 'Todoist', color: '#E44332', mark: 'td', does: ['See your tasks, by any Todoist filter', 'Add tasks and tick them off'] },
  notion: { name: 'Notion', color: '#000', mark: 'N', does: ['Search and read the pages you share with Carino', 'Create pages and add notes to them'] },
  linear: { name: 'Linear', color: '#5E6AD2', mark: 'L', does: ['See issues assigned to you', 'Create issues and comment (after your OK)'] },
  github: { name: 'GitHub', color: '#24292F', mark: 'gh', does: ['See notifications, assigned issues and review requests', 'Read issues; open issues and comment (after your OK)'] },
};
const Mark = ({ id }: { id: string }) => (
  <span aria-hidden="true" style={{ width: 44, height: 44, flex: 'none', borderRadius: 10, display: 'grid', placeItems: 'center', background: KEY_APPS[id].color, color: '#fff', fontWeight: 800 }}>{KEY_APPS[id].mark}</span>
);

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
          <>{t('Open')}{' '}<A href="https://console.cloud.google.com/projectcreate">{t('Google Cloud')}</A> {t('and create a project (any name, e.g. “Carino”). It’s free.')}</>,
          <>{t('In')}{' '}<A href="https://console.cloud.google.com/apis/library">{t('APIs & Services → Library')}</A>{t(', turn on')}{' '}<b>{t('Gmail API')}</b>, <b>{t('Google Calendar API')}</b>, <b>{t('Google Drive API')}</b>, <b>{t('Google Sheets API')}</b> and <b>{t('Google Docs API')}</b>.</>,
          <>{t('Open')}{' '}<A href="https://console.cloud.google.com/auth/overview">{t('Google Auth Platform')}</A> → <b>{t('Get started')}</b>{t(': app name “Carino”, your email, audience')}{' '}<b>{t('External')}</b>{t('. Then under')}{' '}<b>{t('Audience')}</b> tap <b>{t('Publish app')}</b> {t('(otherwise Google signs you out every 7 days).')}</>,
          <>{t('Under')}{' '}<b>{t('Clients')}</b> → <b>{t('Create client')}</b>{t(', choose')}{' '}<b>{t('Desktop app')}</b>{t('. Copy the')}{' '}<b>{t('Client ID')}</b> and <b>{t('Client secret')}</b> here.</>,
        ],
        note: <>{t('When you sign in, Google says the app isn’t verified — that’s expected for your own app. Tap')}{' '}<b>{t('Advanced → Go to Carino')}</b>{t('. For a second Google account, just sign in again.')}</>,
      };
    case 'microsoft':
      return {
        idLabel: 'Application (client) ID', secretLabel: '',
        steps: [
          <>{t('Open')}{' '}<A href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">{t('Microsoft Entra → App registrations')}</A> {t('(free, sign in with your Microsoft account) and tap')}{' '}<b>{t('New registration')}</b>.</>,
          <>{t('Name it “Carino”. Who can use it:')}{' '}<b>{t('Accounts in any organizational directory and personal Microsoft accounts')}</b>.</>,
          <>{t('Redirect URI: choose')}{' '}<b>{t('Public client/native (mobile & desktop)')}</b> {t('and enter')}{' '}{R} {t('Tap')}{' '}<b>{t('Register')}</b>.</>,
          <>{t('Copy the')}{' '}<b>{t('Application (client) ID')}</b> {t('here. No secret is needed.')}</>,
        ],
        note: <>{t('Work or school accounts may need their IT admin to allow the app.')}</>,
      };
    case 'meta':
      return {
        idLabel: 'App ID', secretLabel: 'App secret',
        steps: [
          <>{t('Open')}{' '}<A href="https://developers.facebook.com/apps/creation/">{t('Meta for Developers → Create app')}</A> {t('(free). Choose the use cases')}{' '}<b>{t('Manage everything on your Page')}</b> and <b>{t('Manage messaging & content on Instagram')}</b>.</>,
          <>{t('In')}{' '}<b>{t('App settings → Basic')}</b>{t(', copy the')}{' '}<b>{t('App ID')}</b> and <b>{t('App secret')}</b> here.</>,
          <>{t('In')}{' '}<b>{t('Facebook Login → Settings')}</b>{t(', add this to')}{' '}<b>{t('Valid OAuth Redirect URIs')}</b>: {R}</>,
          <>{t('Leave the app in')}{' '}<b>{t('Development')}</b> {t('mode: as its admin you can use it without Meta’s review.')}</>,
        ],
        note: <>{t('Facebook lets apps post to')}{' '}<b>{t('Pages')}</b> {t('you manage, not your personal profile. Instagram needs a')}{' '}<b>{t('Business or Creator')}</b> {t('account linked to one of your Pages. One Meta app works for Facebook, Instagram and WhatsApp.')}</>,
      };
    case 'x':
      return {
        idLabel: 'OAuth 2.0 Client ID', secretLabel: 'Client secret (if shown)',
        steps: [
          <>{t('Open the')}{' '}<A href="https://developer.x.com/en/portal/dashboard">{t('X Developer Portal')}</A> {t('and sign up for the')}{' '}<b>{t('Free')}</b> plan.</>,
          <>{t('In your app →')}{' '}<b>{t('User authentication settings → Set up')}</b>{t(': permissions')}{' '}<b>{t('Read and write')}</b>{t(', type')}{' '}<b>{t('Native App')}</b>.</>,
          <>{t('Callback URI:')}{' '}{R} {t('— website: any link of yours.')}</>,
          <>{t('Under')}{' '}<b>{t('Keys and tokens')}</b>{t(', copy the')}{' '}<b>{t('OAuth 2.0 Client ID')}</b> {t('(and secret, if X shows one) here.')}</>,
        ],
        note: <>{t('X’s free plan allows about 500 posts a month and very few reads.')}</>,
      };
    case 'linkedin':
      return {
        idLabel: 'Client ID', secretLabel: 'Client secret',
        steps: [
          <>{t('Open')}{' '}<A href="https://www.linkedin.com/developers/apps/new">{t('LinkedIn Developers → Create app')}</A> {t('(free). LinkedIn asks for a Page to link it to; any Page you manage works.')}</>,
          <>{t('Under')}{' '}<b>{t('Products')}</b>{t(', add')}{' '}<b>{t('Sign In with LinkedIn using OpenID Connect')}</b> and <b>{t('Share on LinkedIn')}</b>.</>,
          <>{t('Under')}{' '}<b>{t('Auth')}</b>{t(', add this')}{' '}<b>{t('Authorized redirect URL')}</b>: {R}</>,
          <>{t('Copy the')}{' '}<b>{t('Client ID')}</b> and <b>{t('Client secret')}</b> here.</>,
        ],
        note: <>{t('LinkedIn sign-ins last 60 days; Carino tells you when to sign in again.')}</>,
      };
    case 'tiktok':
      return {
        idLabel: 'Client key', secretLabel: 'Client secret',
        steps: [
          <>{t('Open')}{' '}<A href="https://developers.tiktok.com/apps/">{t('TikTok for Developers → Manage apps')}</A> {t('and connect a new app (free).')}</>,
          <>{t('Add the products')}{' '}<b>{t('Login Kit')}</b> and <b>{t('Content Posting API')}</b>{t('. Platform:')}{' '}<b>{t('Desktop')}</b>{t('. Redirect URI:')}{' '}{R}</>,
          <>{t('Turn on')}{' '}<b>{t('Sandbox')}</b> {t('and add your TikTok account under')}{' '}<b>{t('Target users')}</b> {t('(no review needed for your own account).')}</>,
          <>{t('Copy the')}{' '}<b>{t('Client key')}</b> and <b>{t('Client secret')}</b> here.</>,
        ],
        note: <>{t('Videos arrive in your TikTok notifications as drafts; you add the sound and caption and post them yourself.')}</>,
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

  if (apps.loading) return <Shell title={t('My apps')}><Loading /></Shell>;
  if (apps.error) return <Shell title={t('My apps')}><ErrorBox error={apps.error} retry={apps.reload} /></Shell>;
  const list = apps.data!.apps;
  const app = id ? list.find((a) => a.id === id) : undefined;
  if (app?.key) return <KeyAppDetail app={app} reload={apps.reload} />;
  if (app) return <AppDetail app={app} reload={apps.reload} />;

  const wa = chans.data?.channels?.find((c: any) => c.kind === 'whatsapp');
  const tg = chans.data?.channels?.find((c: any) => c.kind === 'telegram');
  const order = ['google', 'microsoft', 'instagram', 'facebook', 'x', 'linkedin', 'tiktok'];
  return (
    <Shell title={t('My apps')}>
      <div className="page narrow">
        <div className="page-head"><div>
          <h1><Icon name="link" /> {t('My apps')}</h1>
          <p className="sub">{t('Connect your accounts so Carino can read and act for you. Sending email and posting always waits for your OK.')}</p>
        </div></div>
        <ul className="app-list" aria-label={t('Apps')}>
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
          {Object.keys(KEY_APPS).map((pid) => {
            const a = list.find((x) => x.id === pid);
            if (!a) return null;
            const warn = a.accounts.some((x) => x.last_error);
            return (
              <li key={pid}>
                <Link to={`/apps/${pid}`} className="app-item">
                  <Mark id={pid} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="app-name">{KEY_APPS[pid].name}</span>
                    <span className={`app-status ${warn ? 'warn' : ''}`}><Dot ok={a.accounts.length > 0 && !warn} /><span className="ellipsis">{a.accounts.length ? (warn ? 'Needs attention' : a.accounts[0].label) : 'Tap to connect'}</span></span>
                  </span>
                  <Icon name="chevron" size={16} />
                </Link>
              </li>
            );
          })}
          <AppItem to="/messaging" logo="telegram" name="Telegram" ok={!!tg?.enabled} status={tg ? (tg.enabled ? `Connected · @${tg.config.bot_username}` : 'Turned off') : 'Tap to set up'} />
          <AppItem to="/connectors" logo="more" name="More apps" status="Zapier and other MCP apps" />
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
          <span className="app-name">{name}{beta && <span className="badge">{t('Beta')}</span>}{badge && <span className="badge">{badge}</span>}</span>
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
      toast(t('Saved. Now sign in.'));
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
        <button className="btn ghost sm" onClick={() => navigate('/apps')} style={{ marginBottom: 8 }}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} />{t('My apps')}</button>
        <section className="card pad app-hero">
          <AppLogo id={app.id as AppLogoId} size={56} />
          <div className="grow">
            <h1>{about.name}{about.beta && <span className="badge" style={{ marginLeft: 8 }}>{t('Beta')}</span>}</h1>
            <ul className="small muted app-does">{about.does.map((d) => <li key={d}>{d}</li>)}</ul>
          </div>
        </section>

        <section className="card pad" style={{ marginTop: 14 }}>
          <h2>{t('Accounts')}</h2>
          {app.accounts.length ? (
            <ul className="list divided" style={{ marginTop: 6 }}>
              {app.accounts.map((a) => (
                <li key={a.id} className="list-item">
                  <Dot ok={!a.last_error} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="ellipsis" style={{ display: 'block' }}>{a.label}</span>
                    {a.last_error && <span className="tiny" style={{ color: 'var(--danger)' }}>{a.last_error}</span>}
                  </span>
                  {a.last_error && <button className="btn sm" onClick={signIn} disabled={busy}>{t('Sign in again')}</button>}
                  <button className="btn ghost icon sm" aria-label={`Disconnect ${a.label}`} onClick={async () => {
                    if (!(await confirm({ title: `Disconnect ${a.label}?`, body: `Carino forgets this ${about.name} sign-in. Nothing in your account is changed.`, confirm: 'Disconnect', danger: true }))) return;
                    await del(`/apps/accounts/${a.id}`).catch((e) => toast(e.message, 'error'));
                    reload();
                  }}><Icon name="x" size={14} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="small muted" style={{ marginTop: 4 }}>{t('Not connected yet.')}</p>}
          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy || (!app.client && !app.one_tap)} onClick={signIn}>
              <Icon name="lock" size={15} />{app.accounts.length ? `Add another ${about.name} account` : `Sign in with ${about.name}`}
            </button>
            {!app.client && !app.one_tap && <span className="small muted">{t('First do the one-time setup below.')}</span>}
          </div>
        </section>

        {app.one_tap && !app.client && (
          <p className="small muted" style={{ marginTop: 10 }}>{t('You sign in on')}{' '}{about.name}{t('’s own page and choose what Carino may do. Your sign-in is kept on this phone.')}</p>
        )}
        <details className="card pad" style={{ marginTop: 14 }} open={!app.client && !app.one_tap}>
          {app.one_tap
            ? <summary><h2 style={{ display: 'inline', fontSize: '1rem' }}>{t('Advanced: use my own developer app')}</h2></summary>
            : <summary><h2 style={{ display: 'inline' }}>{t('One-time setup')}</h2> <span className="small muted">{t('· about 5 minutes, free')}</span></summary>}
          <p className="small muted" style={{ marginTop: 8 }}>
            {t('Carino talks to')}{' '}{about.name} {t('directly from your phone, with your own free developer app — nothing goes through anyone else’s server.')}
            {shared && <> {t('This is the same Meta app as')}{' '}{shared}{t(': set it up once for both.')}</>}
          </p>
          <ol className="small steps">{g.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {g.note && <div className="callout small" style={{ marginTop: 10 }}><Icon name="info" size={16} /><span>{g.note}</span></div>}
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="redirect">{t('Redirect address')}</label>
            <div className="row">
              <input id="redirect" className="input mono grow" readOnly value={app.redirect_uri} />
              <button className="btn sm" onClick={() => navigator.clipboard?.writeText(app.redirect_uri).then(() => toast(t('Copied')), () => undefined)}><Icon name="copy" size={14} />{t('Copy')}</button>
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
            <button className="btn" disabled={busy || clientId.trim().length < 4 || (app.needs_secret && !secret.trim())} onClick={save}>{t('Save')}</button>
            {app.client && <button className="btn ghost sm" onClick={async () => {
              if (!(await confirm({ title: 'Remove the developer app?', body: 'Signed-in accounts keep working until their sign-in expires.', confirm: 'Remove', danger: true }))) return;
              await del(`/apps/clients/${app.group}`);
              setClientId('');
              setSecret('');
              reload();
            }}>{t('Remove')}</button>}
          </div>
        </details>
        <p className="tiny faint" style={{ marginTop: 12 }}>{t('Your sign-ins are stored encrypted on this phone. Carino asks before sending email or posting anything. You can change what it may do on its own in')}{' '}<Link to="/settings#permissions">{t('Settings')}</Link>.</p>
      </div>
    </Shell>
  );
}

/** Apps connected with a pasted personal token (Slack, Todoist, Notion, Linear, GitHub). */
function KeyAppDetail({ app, reload }: { app: AppRow; reload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const about = KEY_APPS[app.id];
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const r = await post<{ account: { label: string } }>(`/apps/${app.id}/key`, { token: token.trim() });
      setToken('');
      toast(`Connected ${r.account.label}`);
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={about.name}>
      <div className="page narrow stack">
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <Mark id={app.id} />
          <div><h1>{about.name}</h1>{about.does.map((d) => <p key={d} className="muted small">• {d}</p>)}</div>
        </div>
        <h2>{t('Accounts')}</h2>
        {!app.accounts.length && <p className="muted">{t('Not connected yet.')}</p>}
        {app.accounts.map((a) => (
          <div key={a.id} className="row">
            <Dot ok={!a.last_error} />
            <span className="grow">{a.label}{a.last_error && <span className="small" style={{ color: 'var(--danger)' }}> — {a.last_error}</span>}</span>
            <button className="btn ghost sm" onClick={async () => {
              if (!(await confirm({ title: `Disconnect ${a.label}?`, body: `Carino forgets this ${about.name} token. Nothing in your account changes.`, confirm: 'Disconnect', danger: true }))) return;
              await del(`/apps/accounts/${a.id}`).catch((e) => toast(e.message, 'error'));
              reload();
            }}>{t('Disconnect')}</button>
          </div>
        ))}
        <div className="card stack">
          <h2>{app.accounts.length ? 'Add another account' : 'Connect with a personal token'}</h2>
          <p className="small">{app.key!.steps} <A href={app.key!.url}>{t('Open')}{' '}{about.name}</A></p>
          <input type="password" autoComplete="off" placeholder={app.key!.placeholder} value={token} onChange={(e) => setToken(e.target.value)} aria-label={t('Token')} />
          <button className="btn primary" disabled={busy || token.trim().length < 8} onClick={connect}>{t('Connect')}</button>
        </div>
        <p className="muted small">{t('The token is stored encrypted and only sent to')}{' '}{about.name}{t('. Changes and messages wait for your OK unless you allow them in Settings → Permissions.')}</p>
      </div>
    </Shell>
  );
}
