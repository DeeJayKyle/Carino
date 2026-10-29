import { useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading, Switch, useConfirm, useToast } from '../components/ui';
import { useData } from '../lib/hooks';
import { del, get, patch, post, put } from '../lib/api';
import { Link } from '../lib/router';
import { fmtDateTime } from '../lib/format';

export default function Messaging() {
  const { data, error, loading, reload } = useData<any>('/channels');
  const tg = data?.channels.find((c: any) => c.kind === 'telegram');
  const wa = data?.channels.find((c: any) => c.kind === 'whatsapp');
  return (
    <Shell title="Messaging">
      <div className="page" style={{ maxWidth: 900 }}>
        <div className="page-head"><div>
          <h1>Talk to Carino from your messaging apps</h1>
          <p className="sub">Message Carino from WhatsApp or Telegram as you would a friend — text, voice notes and photos. Add Carino to a family or team group to keep lists and plans in one place. Each chat gets its own conversation here in Carino.</p>
        </div></div>
        {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : (
          <div className="stack-lg">
            {!data.transcription && (
              <div className="callout small"><Icon name="mic" size={16} /><span>To understand voice notes, add a free Groq key in <Link to="/settings#ai">Settings → AI service</Link> (under “More options”, or choose Groq as the AI service). Text and photos work without it.</span></div>
            )}
            <TelegramCard ch={tg} reload={reload} />
            <WhatsAppCard ch={wa} reload={reload} />
            {(tg || wa) && <Background />}
            <section className="card pad small muted">
              <h3 style={{ marginBottom: 6 }}>Privacy in chats</h3>
              <ul style={{ paddingLeft: 18 }}>
                <li>Only chats you link with a one-time code are answered. In your private chat, only your own account is answered.</li>
                <li>In groups Carino answers only when mentioned or replied to, can add to-dos and reminders, look things up and find places — but can’t see your memories, tasks, notes or documents.</li>
                <li>Anything that needs approval shows <b>Approve</b> / <b>Decline</b> buttons in your private chat, and waits in <Link to="/actions">Approvals</Link>.</li>
                <li>Send <code>/stop</code> in any chat to make Carino go quiet there, <code>/start</code> to bring it back.</li>
              </ul>
            </section>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Chats({ ch, reload }: { ch: any; reload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  if (!ch.chats.length) return null;
  return (
    <ul className="list divided" style={{ marginTop: 10 }}>
      {ch.chats.map((c: any) => (
        <li key={c.id} className="list-item">
          <Icon name={c.is_group ? 'user' : 'chat'} size={16} />
          <span className="grow ellipsis">{c.title || (c.is_group ? 'Group' : 'Private chat')}<span className="faint small"> · {c.is_group ? 'group' : 'private'} · linked {fmtDateTime(c.created_at, { time: false })}</span></span>
          {c.conversation_id && <Link className="btn ghost sm" to={`/chat/${c.conversation_id}`}>Open</Link>}
          <Switch label={`${c.muted ? 'Unmute' : 'Mute'} ${c.title}`} checked={!c.muted} onChange={async (v) => { await patch(`/channel-chats/${c.id}`, { muted: !v }); reload(); }} />
          <button className="btn ghost icon sm" aria-label={`Unlink ${c.title}`} onClick={async () => {
            if (!(await confirm({ title: `Unlink ${c.title || 'this chat'}?`, body: 'Carino stops answering there. Its conversation stays in Chat.', confirm: 'Unlink', danger: true }))) return;
            await del(`/channel-chats/${c.id}`).catch((e) => toast(e.message, 'error'));
            reload();
          }}><Icon name="x" size={14} /></button>
        </li>
      ))}
    </ul>
  );
}

function Pairing({ ch, reload, howTo }: { ch: any; reload: () => void; howTo: string }) {
  const [code, setCode] = useState<string | null>(ch.pairing_code);
  return (
    <div className="callout small" style={{ marginTop: 10, alignItems: 'center' }}>
      <Icon name="lock" size={16} />
      {code ? <span className="grow">{howTo} <b className="mono" style={{ fontSize: '1.15em', letterSpacing: 2 }}>{code}</b> — valid for 15 minutes.</span>
        : <span className="grow">Link a chat or group with a one-time code.</span>}
      <button className="btn sm" onClick={async () => { setCode((await post(`/channels/${ch.id}/pair`)).pairing_code); reload(); }}>{code ? 'New code' : 'Get a code'}</button>
    </div>
  );
}

function ChannelHeader({ ch, title, sub, reload }: { ch: any; title: string; sub: string; reload: () => void }) {
  const confirm = useConfirm();
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow"><h2>{title}</h2><p className="small muted">{sub}</p></div>
        <Switch label={`${ch.enabled ? 'Turn off' : 'Turn on'} ${title}`} checked={ch.enabled} onChange={async (v) => { await patch(`/channels/${ch.id}`, { enabled: v }); reload(); }} />
      </div>
      {ch.last_error && <p className="small" style={{ color: 'var(--danger)' }}>{ch.last_error}</p>}
      <div className="row wrap" style={{ marginTop: 8 }}>
        <label className="checkbox small"><input type="checkbox" checked={ch.config.transcribe_voice !== false} onChange={async (e) => { await patch(`/channels/${ch.id}`, { transcribe_voice: e.target.checked }); reload(); }} />Transcribe voice notes</label>
        <span className="grow" />
        <button className="btn ghost sm" onClick={async () => {
          if (!(await confirm({ title: `Disconnect ${title}?`, body: 'All linked chats are unlinked and the saved token is deleted.', confirm: 'Disconnect', danger: true }))) return;
          await del(`/channels/${ch.id}`);
          reload();
        }}><Icon name="trash" size={14} />Disconnect</button>
      </div>
    </>
  );
}

function TelegramCard({ ch, reload }: { ch: any; reload: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  if (ch) {
    return (
      <section className="card pad">
        <ChannelHeader ch={ch} title="Telegram" sub={`Your bot: @${ch.config.bot_username}${ch.last_seen_at ? ` · last message ${fmtDateTime(ch.last_seen_at)}` : ''}`} reload={reload} />
        <Pairing ch={ch} reload={reload} howTo={`Open @${ch.config.bot_username} in Telegram and send`} />
        <p className="tiny faint" style={{ marginTop: 6 }}>For a group: add @{ch.config.bot_username} to the group, then send <code>/link CODE</code> there. In @BotFather, turn off <i>Group Privacy</i> only if you want Carino to see unmentioned messages (not needed).</p>
        <Chats ch={ch} reload={reload} />
      </section>
    );
  }
  return (
    <section className="card pad stack">
      <h2>Telegram <span className="badge brand">free</span></h2>
      <ol className="small" style={{ paddingLeft: 18 }}>
        <li>In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> and send <code>/newbot</code>. Pick a name (e.g. “Carino”) and a username ending in <i>bot</i>.</li>
        <li>BotFather replies with a token like <code>123456789:AAE…</code>. Paste it here.</li>
        <li>Carino shows a 6-digit code — send it to your new bot. Done. No public web address is needed.</li>
      </ol>
      <div className="row wrap">
        <input className="input grow" type="password" autoComplete="off" placeholder="Bot token from @BotFather" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Telegram bot token" />
        <button className="btn primary" disabled={busy || token.trim().length < 20} onClick={async () => {
          setBusy(true);
          try {
            await post('/channels/telegram', { token });
            toast('Telegram connected — now send the code to your bot');
            reload();
          } catch (e: any) {
            toast(e.message, 'error');
          } finally {
            setBusy(false);
          }
        }}>{busy ? 'Connecting…' : 'Connect Telegram'}</button>
      </div>
    </section>
  );
}


function Copyable({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="field" style={{ marginTop: 8 }}>
      <label>{label}</label>
      <div className="row">
        <input className="input mono grow" readOnly value={value} aria-label={label} />
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(value).then(() => toast('Copied'), () => undefined)}><Icon name="copy" size={14} />Copy</button>
      </div>
    </div>
  );
}

function WhatsAppCard({ ch, reload }: { ch: any; reload: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ phone_number_id: '', access_token: '', app_secret: '' });
  const [relay, setRelay] = useState(ch?.config?.relay_url ?? '');
  const [cfToken, setCfToken] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const linked = !!ch?.config?.relay_url;
  return (
    <section className="card pad stack" id="whatsapp">
      {ch ? (
        <ChannelHeader ch={ch} title="WhatsApp" sub={`Carino’s number: ${ch.config.display_phone || ch.config.phone_number_id}${ch.last_seen_at ? ` · last message ${fmtDateTime(ch.last_seen_at)}` : ''}`} reload={reload} />
      ) : (
        <>
          <h2>WhatsApp <span className="badge">Beta</span></h2>
          <p className="small muted">Like Toqi: Carino gets its own WhatsApp number that you chat with. It uses Meta’s official WhatsApp Business platform (free for chats you start) and a tiny free relay that holds messages until your phone collects them.</p>
        </>
      )}

      <ol className="small steps">
        <li className={ch ? 'done' : ''}>
          <b>Your Meta app.</b> At <a href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noopener noreferrer">Meta for Developers</a>, create an app (or use the one from My apps → Facebook) and add <b>WhatsApp</b>. Under <b>WhatsApp → API Setup</b>, Meta gives you a free test number; add your own WhatsApp number as a recipient.
          <br />Copy the <b>Phone number ID</b>; make a permanent <b>access token</b> in <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener noreferrer">Business settings → System users</a> (with <i>whatsapp_business_messaging</i>); and copy the <b>App secret</b> from <b>App settings → Basic</b>.
          {!ch && (
            <div className="stack" style={{ marginTop: 8 }}>
              <input className="input mono" placeholder="Phone number ID" inputMode="numeric" value={f.phone_number_id} onChange={(e) => setF({ ...f, phone_number_id: e.target.value })} aria-label="Phone number ID" />
              <input className="input mono" type="password" autoComplete="off" placeholder="Access token" value={f.access_token} onChange={(e) => setF({ ...f, access_token: e.target.value })} aria-label="Access token" />
              <input className="input mono" type="password" autoComplete="off" placeholder="App secret" value={f.app_secret} onChange={(e) => setF({ ...f, app_secret: e.target.value })} aria-label="App secret" />
              <button className="btn primary" disabled={busy || !f.phone_number_id || !f.access_token || !f.app_secret} onClick={() => run(() => post('/channels/whatsapp', f), 'WhatsApp connected — now set up the relay')}>{busy ? 'Connecting…' : 'Connect WhatsApp'}</button>
            </div>
          )}
        </li>
        <li className={linked ? 'done' : ''}>
          <b>Your relay</b> (free). Meta delivers messages to a web address that’s always on; the relay is that address, on your own Cloudflare account.
          <br />Make a free <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener noreferrer">Cloudflare account</a>, then in <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">API Tokens</a> tap <b>Create Token</b> → <b>Edit Cloudflare Workers</b> → <b>Use template</b> → <b>Continue</b> → <b>Create</b>, and paste the token here. Carino sets the relay up and links it (the token isn’t kept).
          {ch && (
            <div className="stack" style={{ marginTop: 8 }}>
              <div className="row wrap">
                <input className="input mono grow" type="password" autoComplete="off" placeholder="Cloudflare API token" value={cfToken} onChange={(e) => setCfToken(e.target.value)} aria-label="Cloudflare API token" />
                <button className="btn primary" disabled={busy || cfToken.trim().length < 20} onClick={() => run(async () => { await post('/channels/whatsapp/relay/create', { token: cfToken }); setCfToken(''); }, 'Relay created and linked')}>{busy ? 'Setting up…' : linked ? 'Create again' : 'Create my relay'}</button>
              </div>
              <details className="small">
                <summary className="muted">I already have a relay</summary>
                <div className="row wrap" style={{ marginTop: 6 }}>
                  <input className="input mono grow" inputMode="url" placeholder="https://…workers.dev" value={relay} onChange={(e) => setRelay(e.target.value)} aria-label="Relay address" />
                  <button className="btn" disabled={busy || relay.trim().length < 12} onClick={() => run(() => post('/channels/whatsapp/relay', { url: relay }), 'Relay linked')}>{linked ? 'Link again' : 'Link relay'}</button>
                </div>
              </details>
              {linked && <p className="tiny faint">Relay: <span className="mono">{ch.config.relay_url}</span></p>}
            </div>
          )}
        </li>
        <li className={ch?.last_seen_at ? 'done' : ''}>
          <b>Tell Meta where to deliver.</b> In <b>WhatsApp → Configuration → Webhook</b>, tap <b>Edit</b>, paste these two values, <b>Verify and save</b>, then subscribe to <b>messages</b>.
          {linked && ch.webhook_url && <><Copyable label="Callback URL" value={ch.webhook_url} /><Copyable label="Verify token" value={ch.config.verify_token} /></>}
        </li>
        <li><b>Say hello.</b> Get a code below and send it from your WhatsApp to Carino’s number.</li>
      </ol>
      {ch && linked && <Pairing ch={ch} reload={reload} howTo={`Send this from your WhatsApp to ${ch.config.display_phone || 'Carino’s number'}:`} />}
      {ch && <Chats ch={ch} reload={reload} />}
      <p className="tiny faint">Replies to your messages are free. Meta only charges for messages a business starts after 24 hours of silence, which Carino doesn’t send. The relay only holds Meta’s deliveries until your phone collects them (at most 7 days); your app secret and replies never pass through it.</p>
    </section>
  );
}

/** Keeps answering while Carino is in the background (Android shows a quiet ongoing notification). */
function Background() {
  const [state, setState] = useState<{ on: boolean; native: boolean } | null>(null);
  useEffect(() => { get('/device/listen').then(setState, () => setState(null)); }, []);
  if (!state?.native) return null;
  return (
    <section className="card pad">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <h2>Answer in the background</h2>
          <p className="small muted">Carino keeps answering WhatsApp and Telegram while you use other apps, with a quiet “Carino is listening” notification. If you swipe Carino away, messages wait until you open it again.</p>
        </div>
        <Switch label="Answer in the background" checked={state.on} onChange={async (v) => setState(await put('/device/listen', { on: v }))} />
      </div>
    </section>
  );
}
