import { t, APP_LANGUAGES } from '../lib/i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading, Modal, Seg, Switch, useConfirm, useToast } from '../components/ui';
import { useData } from '../lib/hooks';
import { api, del, patch, post } from '../lib/api';
import { useSession } from '../lib/session';
import { fmtDateTime } from '../lib/format';
import { speak } from '../lib/voice';
import { Link } from '../lib/router';
import { ApiDownload } from '../components/ApiFile';
import { DeviceAI } from '../components/DeviceAI';
import { BackupCard } from '../components/BackupCard';
import { Devices } from '../components/Devices';
import { AccessOverview } from '../components/AccessOverview';
import { MOBILE } from '../lib/device';

const SECTIONS = [
  ['profile', 'Profile & assistant', 'user'],
  ['ai', 'AI service', 'sparkle'],
  ['memory', 'Memory', 'brain'],
  ['permissions', 'Permissions', 'shield'],
  ['access', 'What Carino can reach', 'eye'],
  ['notifications', 'Notifications & routines', 'bell'],
  ['appearance', 'Appearance & accessibility', 'sun'],
  ['regional', 'Language & region', 'globe'],
  ['voice', 'Voice', 'mic'],
  ['devices', 'Devices', 'phone'],
  ['privacy', 'Privacy, data & account', 'lock'],
] as const;

export default function Settings() {
  const [section, setSection] = useState<string>(() => location.hash.slice(1) || 'profile');
  useEffect(() => {
    const h = () => setSection(location.hash.slice(1) || 'profile');
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  const go = (s: string) => {
    history.replaceState(null, '', `#${s}`);
    setSection(s);
  };
  return (
    <Shell title={t('Settings')}>
      <div className="page">
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 240px) minmax(0, 1fr)', gap: 24 }} className="settings-grid">
          <nav className="settings-nav desktop-only" aria-label={t('Settings sections')}>
            {SECTIONS.map(([id, label, icon]) => (
              <button key={id} className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => go(id)}><Icon name={icon} size={16} />{label}</button>
            ))}
          </nav>
          <div>
            <select className="select mobile-only" style={{ marginBottom: 14, width: '100%' }} value={section} onChange={(e) => go(e.target.value)} aria-label={t('Settings section')}>
              {SECTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            {section === 'profile' && <Profile />}
            {section === 'ai' && <AI />}
            {section === 'memory' && <MemorySettings />}
            {section === 'permissions' && <Permissions />}
            {section === 'access' && <Card title={t('What Carino can reach')} desc="Every folder, app, account, tool, device and chat Carino has access to. Remove any of them here at any time."><AccessOverview /></Card>}
            {section === 'notifications' && <Notifications />}
            {section === 'appearance' && <Appearance />}
            {section === 'regional' && <Regional />}
            {section === 'voice' && <Voice />}
            {section === 'devices' && <Card title={t('Devices')} desc="Your phone and your PC, kept in step."><Devices /></Card>}
            {section === 'privacy' && <Privacy />}
          </div>
        </div>
      </div>
      <style>{`@media (max-width: 860px) { .settings-grid { grid-template-columns: 1fr !important; } }`}</style>
    </Shell>
  );
}

function Card({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="card pad" style={{ marginBottom: 16 }}>
      <h2>{title}</h2>
      {desc && <p className="small muted" style={{ marginTop: 4 }}>{desc}</p>}
      <div style={{ marginTop: 8 }}>{children}</div>
    </section>
  );
}

function Row({ label, desc, children }: { label: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="grow"><div style={{ fontWeight: 600 }}>{label}</div>{desc && <div className="desc">{desc}</div>}</div>
      <div className="row wrap" style={{ justifyContent: 'flex-end' }}>{children}</div>
    </div>
  );
}

/** Saves a settings patch and shows a toast on success/failure. */
function useSave() {
  const { saveSettings } = useSession();
  const toast = useToast();
  return async (p: any, msg = 'Saved') => {
    try {
      await saveSettings(p);
      toast(msg);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
}

function Profile() {
  const { me } = useSession();
  const save = useSave();
  const s = me!.settings.profile;
  const [name, setName] = useState(s.displayName);
  const [instr, setInstr] = useState(s.customInstructions);
  const [aname, setAname] = useState(s.assistantName || 'Carino');
  const [lang, setLang] = useState(s.replyLanguage || '');
  return (
    <>
    <Card title={t('Profile & assistant')} desc="How Carino addresses you and how it responds. Changes apply to new conversations.">
      <Row label={t('Your name')}><input className="input" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== s.displayName && save({ profile: { displayName: name } })} aria-label={t('Display name')} /></Row>
      <Row label={t('Assistant’s name')} desc="Give your assistant any name you like."><input className="input" style={{ width: 240 }} maxLength={40} value={aname} onChange={(e) => setAname(e.target.value)} onBlur={() => aname.trim() && aname !== s.assistantName && save({ profile: { assistantName: aname.trim() } })} aria-label={t('Assistant name')} /></Row>
      <Row label={t('Reply language')} desc="Leave empty to reply in whatever language you write in.">
        <input className="input" style={{ width: 240 }} list="langs" maxLength={40} placeholder={t('Match my language')} value={lang} onChange={(e) => setLang(e.target.value)} onBlur={() => lang !== s.replyLanguage && save({ profile: { replyLanguage: lang.trim() } })} aria-label={t('Reply language')} />
        <datalist id="langs">{['English', 'Luganda', 'Swahili', 'Kinyarwanda', 'French', 'Spanish', 'Portuguese', 'German', 'Dutch', 'Italian', 'Arabic', 'Hindi'].map((l) => <option key={l} value={l} />)}</datalist>
      </Row>
      <Row label={t('Response style')}>
        <Seg label={t('Response style')} value={s.assistantStyle} onChange={(v) => save({ profile: { assistantStyle: v } })} options={[{ value: 'balanced', label: 'Balanced' }, { value: 'concise', label: 'Concise' }, { value: 'detailed', label: 'Detailed' }, { value: 'warm', label: 'Warm' }]} />
      </Row>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="ci">{t('Instructions for Carino')}</label>
        <textarea id="ci" className="textarea" maxLength={2000} value={instr} onChange={(e) => setInstr(e.target.value)} placeholder={t('e.g. I run a community pharmacy in Kampala. Use UGX for money. Keep plans practical.')} />
        <div className="row"><span className="hint grow">{instr.length}/2000</span><button className="btn sm primary" disabled={instr === s.customInstructions} onClick={() => save({ profile: { customInstructions: instr } })}>{t('Save instructions')}</button></div>
      </div>
    </Card>
    </>
  );
}

/** Learns how the user writes so drafts sound like them. */
function AI() {
  return (
    <Card title={t('AI service')} desc="Carino lives on your phone and asks an AI service to write its replies. Groq, Google Gemini and OpenRouter have free tiers — pick one and paste its key. Or download a small AI that runs on the phone itself, with no internet.">
      <DeviceAI />
      <p className="small" style={{ marginTop: 12 }}><Link to="/connections"><Icon name="sparkle" size={14} /> {t('AI & connections')}</Link> {t('— add more services or local AI, test models, choose one per job and set spending limits.')}</p>
    </Card>
  );
}

function MemorySettings() {
  const { me } = useSession();
  const save = useSave();
  const m = me!.settings.memory;
  const cats = ['profile', 'preference', 'goal', 'routine', 'project', 'date', 'fact', 'summary'];
  return (
    <Card title={t('Memory')} desc="Long-term memory lets Carino remember what matters between conversations. Manage individual memories on the Memory page.">
      <Row label={t('Use long-term memory')} desc="When off, Carino neither reads nor saves memories."><Switch label={t('Use long-term memory')} checked={m.enabled} onChange={(v) => save({ memory: { enabled: v } })} /></Row>
      <Row label={t('When Carino wants to remember something')} desc="Sensitive details (health, finances, IDs, beliefs) and guesses always need your approval.">
        <select className="select" style={{ width: 280 }} value={m.saveMode} onChange={(e) => save({ memory: { saveMode: e.target.value } })} aria-label={t('Memory save mode')}>
          <option value="ask_sensitive">{t('Save what I say; ask about sensitive or inferred')}</option>
          <option value="ask">{t('Always ask me first')}</option>
          <option value="explicit">{t('Only when I explicitly say “remember”')}</option>
        </select>
      </Row>
      <Row label={t('Retention')} desc="Automatically forget new memories after this many days (0 = keep until deleted).">
        <input className="input" type="number" min={0} style={{ width: 120 }} defaultValue={m.retentionDays} onBlur={(e) => Number(e.target.value) !== m.retentionDays && save({ memory: { retentionDays: Number(e.target.value) || 0 } })} aria-label={t('Retention days')} />
      </Row>
      <div style={{ marginTop: 12 }}>
        <div className="label" style={{ marginBottom: 6 }}>{t('Categories Carino may use')}</div>
        <div className="row wrap">{cats.map((c) => (
          <label key={c} className="checkbox small" style={{ marginRight: 12 }}>
            <input type="checkbox" checked={!m.disabledCategories.includes(c)} onChange={(e) => save({ memory: { disabledCategories: e.target.checked ? m.disabledCategories.filter((x: string) => x !== c) : [...m.disabledCategories, c] } })} />{c}
          </label>
        ))}</div>
      </div>
    </Card>
  );
}

function Permissions() {
  const { me } = useSession();
  const save = useSave();
  const tools = useData<any>('/tools');
  const p = me!.settings.permissions;
  const setMode = async (name: string, mode: string) => {
    await save({ permissions: { tools: { ...p.tools, [name]: mode } } }, 'Permission updated');
    tools.reload();
  };
  const groups = [['read', 'Read-only — looks things up, changes nothing'], ['reversible', 'Reversible changes — creates or edits your data'], ['consequential', 'Consequential — deletions; always need approval']];
  return (
    <>
      <Card title={t('Permissions')} desc="Carino only acts through these narrowly scoped tools — there is no general computer or shell access. Revoke any tool at any time.">
        <Row label={t('Allow reversible changes without asking')} desc="E.g. adding to-dos and reminders when you ask for them. Turn off to approve each one.">
          <Switch label={t('Allow reversible changes')} checked={p.autoReversible} onChange={(v) => save({ permissions: { autoReversible: v } }).then(() => tools.reload())} />
        </Row>
      </Card>
      {tools.loading && !tools.data ? <Loading /> : groups.map(([risk, label]) => (
        <Card key={risk} title={label.split(' — ')[0]} desc={label.split(' — ')[1]}>
          {tools.data?.tools.filter((t: any) => t.risk === risk).map((t: any) => (
            <Row key={t.name} label={t.name.replace(/_/g, ' ')} desc={t.description}>
              <select className="select" style={{ width: 150 }} value={t.mode} onChange={(e) => setMode(t.name, e.target.value)} aria-label={`Permission for ${t.name}`}>
                {risk !== 'consequential' && <option value="auto">{t('Allowed')}</option>}
                <option value="ask">{t('Ask me first')}</option>
                <option value="off">{t('Turned off')}</option>
              </select>
            </Row>
          ))}
        </Card>
      ))}
    </>
  );
}

function urlB64ToUint8Array(base64: string) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function Notifications() {
  const { me } = useSession();
  const save = useSave();
  const toast = useToast();
  const n = me!.settings.notifications;
  const push = me!.server.push;
  const devices = useData<any>('/push/devices');
  const routines = useData<any>('/routines');
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [busy, setBusy] = useState(false);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';

  const enable = async () => {
    setBusy(true);
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') throw new Error('Notifications were not allowed. You can change this in your browser’s site settings.');
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) throw new Error('The offline/notification service is not active. Use the installed or production build (npm run build && npm start).');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(push.publicKey!) });
      const json = sub.toJSON();
      await post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys, label: `${navigator.platform || 'Device'} · ${navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d]+/)?.[0] ?? 'browser'}` });
      toast(t('Notifications enabled on this device'));
      devices.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {MOBILE ? (
        <Card title={t('Phone notifications')} desc="Reminders ring on this phone, even when Carino is closed. Routines and briefings run while the app is open or in the background.">
          <Row label={t('Send a test')} desc="Check that notifications are allowed for Carino in your phone’s settings.">
            <button className="btn sm" onClick={() => post('/push/test').then(() => toast(t('Test notification sent'))).catch((e) => toast(e.message, 'error'))}>{t('Send test')}</button>
          </Row>
          <Row label={t('Notifications')} desc="Turn off to keep reminders in-app only."><Switch label={t('Notifications')} checked={n.push} onChange={(v) => save({ notifications: { push: v } })} /></Row>
          <Row label={t('Quiet hours')} desc="Reminders due during quiet hours are delivered when they end.">
            <input type="time" className="input" style={{ width: 120 }} defaultValue={n.quietHoursStart ?? ''} onBlur={(e) => save({ notifications: { quietHoursStart: e.target.value || undefined } })} aria-label={t('Quiet hours start')} />
            <span className="faint">to</span>
            <input type="time" className="input" style={{ width: 120 }} defaultValue={n.quietHoursEnd ?? ''} onBlur={(e) => save({ notifications: { quietHoursEnd: e.target.value || undefined } })} aria-label={t('Quiet hours end')} />
          </Row>
        </Card>
      ) : (
      <Card title={t('Push notifications')} desc="Reminders are scheduled on the server and delivered even when Carino is closed. On Android, install Carino to your home screen for the most reliable delivery; on Windows the browser must be allowed to run in the background.">
        {!push.configured ? (
          <div className="callout warning small"><Icon name="info" size={16} />{t('Push is not configured on the server. Run')}{' '}<code>{t('npm run setup')}</code> {t('to generate VAPID keys, then restart. Reminders still appear in-app under Notifications.')}</div>
        ) : !supported ? (
          <div className="callout warning small"><Icon name="info" size={16} />{t('This browser doesn’t support web push. Reminders will appear in-app.')}</div>
        ) : (
          <Row label={t('This device')} desc={perm === 'granted' ? 'Permission granted.' : perm === 'denied' ? 'Blocked in browser settings.' : 'Not enabled yet.'}>
            <button className="btn primary sm" disabled={busy || perm === 'denied'} onClick={enable}>{busy ? 'Enabling…' : 'Enable on this device'}</button>
            <button className="btn sm" onClick={() => post('/push/test').then((r) => toast(r.sent ? `Test sent to ${r.sent} device(s)` : 'No devices received it — enable notifications first', r.sent ? 'info' : 'error')).catch((e) => toast(e.message, 'error'))}>{t('Send test')}</button>
          </Row>
        )}
        <Row label={t('Send push notifications')} desc="Turn off to keep reminders in-app only."><Switch label={t('Push notifications')} checked={n.push} onChange={(v) => save({ notifications: { push: v } })} /></Row>
        <Row label={t('Quiet hours')} desc="Reminders due during quiet hours are delivered when they end.">
          <input type="time" className="input" style={{ width: 120 }} defaultValue={n.quietHoursStart ?? ''} onBlur={(e) => save({ notifications: { quietHoursStart: e.target.value || undefined } })} aria-label={t('Quiet hours start')} />
          <span className="faint">to</span>
          <input type="time" className="input" style={{ width: 120 }} defaultValue={n.quietHoursEnd ?? ''} onBlur={(e) => save({ notifications: { quietHoursEnd: e.target.value || undefined } })} aria-label={t('Quiet hours end')} />
        </Row>
        {devices.data?.devices.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="label">{t('Subscribed devices')}</div>
            <ul className="list">{devices.data.devices.map((d: any) => (
              <li key={d.id} className="list-item"><Icon name="bell" size={16} /><span className="grow small">{d.device_label || 'Device'} {t('· since')}{' '}{fmtDateTime(d.created_at, { time: false })}</span>
                <button className="btn ghost sm" onClick={async () => { await del(`/push/devices/${d.id}`); devices.reload(); }}>{t('Remove')}</button></li>
            ))}</ul>
          </div>
        )}
      </Card>
      )}
      <Card title={t('Routines')} desc={<>{t('Scheduled briefings built from your real data, plus routines of your own. Manage them all, and browse ideas, on the')}{' '}<Link to="/routines">{t('Routines page')}</Link>.</>}>
        {routines.data?.routines.filter((r: any) => !r.custom).map((r: any) => (
          <Row key={r.id} label={r.title} desc={<>{r.kind === 'morning_briefing' ? 'Your day: to-dos, anything overdue and today’s reminders.' : 'What you completed, what’s still open, project progress and tomorrow’s priorities.'}{r.last_run_at && <> {t('· Last run')}{' '}{fmtDateTime(r.last_run_at)}: {r.last_status === 'failed' ? <span className="badge danger">failed</span> : 'ok'}</>}</>}>
            <input type="time" className="input" style={{ width: 120 }} defaultValue={r.time_local} onBlur={async (e) => { if (e.target.value && e.target.value !== r.time_local) { await patch(`/routines/${r.id}`, { time_local: e.target.value }); toast(t('Time saved')); routines.reload(); } }} aria-label={t('Routine time')} />
            <Switch label={`Enable ${r.title}`} checked={r.enabled} onChange={async (v) => { await patch(`/routines/${r.id}`, { enabled: v }); routines.reload(); }} />
          </Row>
        ))}
        {routines.data?.routines.some((r: any) => r.custom) && <p className="small muted" style={{ marginTop: 8 }}>{t('You also have')}{' '}{routines.data.routines.filter((r: any) => r.custom).length} {t('routine(s) of your own —')}{' '}<Link to="/routines">{t('manage them')}</Link>.</p>}
      </Card>
    </>
  );
}

function Appearance() {
  const { me } = useSession();
  const save = useSave();
  const a = me!.settings.appearance;
  return (
    <Card title={t('Appearance & accessibility')}>
      <Row label={t('Theme')}><Seg label={t('Theme')} value={a.theme} onChange={(v) => save({ appearance: { theme: v } })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></Row>
      <Row label={t('Colour palette')} desc="Classic is Carino’s original look. Midnight uses deep navy surfaces with emerald and cyan accents."><Seg label={t('Colour palette')} value={a.palette ?? 'classic'} onChange={(v) => save({ appearance: { palette: v } })} options={[{ value: 'classic', label: 'Classic' }, { value: 'midnight', label: 'Midnight' }]} /></Row>
      <Row label={t('Text size')}><Seg label={t('Text size')} value={a.textSize} onChange={(v) => save({ appearance: { textSize: v } })} options={[{ value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }]} /></Row>
      <Row label={t('Reduce motion')} desc="Turns off animations."><Switch label={t('Reduce motion')} checked={a.reduceMotion} onChange={(v) => save({ appearance: { reduceMotion: v } })} /></Row>
      <div className="callout small" style={{ marginTop: 12 }}>
        <Icon name="info" size={16} />
        <div>{t('Keyboard shortcuts:')}{' '}<span className="kbd">{t('Ctrl K')}</span> {t('search ·')}{' '}<span className="kbd">/</span> {t('focus the message box ·')}{' '}<span className="kbd">{t('Alt 1–7')}</span> {t('switch sections ·')}{' '}<span className="kbd">{t('Esc')}</span> {t('close dialogs ·')}{' '}<span className="kbd">{t('Enter')}</span> {t('send,')}{' '}<span className="kbd">{t('Shift Enter')}</span> {t('new line.')}</div>
      </div>
    </Card>
  );
}

function Regional() {
  const { me } = useSession();
  const save = useSave();
  const r = me!.settings.regional;
  const zones: string[] = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') : [r.timeZone];
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Card title={t('Language & region')} desc="Used for dates, reminders, briefings and natural-language scheduling.">
      <Row label={t('App language')}>
        <select className="select" style={{ width: 260 }} value={r.language ?? ''} onChange={(e) => save({ regional: { language: e.target.value } })} aria-label={t('App language')}>
          {APP_LANGUAGES.map(([v, l]) => <option key={v} value={v}>{v ? l : t(l)}</option>)}
        </select>
      </Row>
      <Row label={t('Time zone')} desc={deviceTz !== r.timeZone ? `This device is set to ${deviceTz}.` : undefined}>
        <select className="select" style={{ width: 260 }} value={r.timeZone} onChange={(e) => save({ regional: { timeZone: e.target.value } })} aria-label={t('Time zone')}>
          {zones.map((z) => <option key={z}>{z}</option>)}
        </select>
        {deviceTz !== r.timeZone && <button className="btn sm" onClick={() => save({ regional: { timeZone: deviceTz } })}>{t('Use device')}</button>}
      </Row>
      <Row label={t('Date format')}>
        <select className="select" style={{ width: 200 }} value={r.locale} onChange={(e) => save({ regional: { locale: e.target.value } })} aria-label={t('Date format')}>
          <option value="en-GB">{t('16 Oct 2026 (UK)')}</option><option value="en-US">{t('Oct 16, 2026 (US)')}</option><option value="en-UG">{t('Uganda (en-UG)')}</option><option value="en-KE">{t('Kenya (en-KE)')}</option><option value="fr-FR">{t('Français')}</option><option value="sw-KE">{t('Kiswahili')}</option>
        </select>
      </Row>
      <Row label={t('12-hour clock')}><Switch label={t('12-hour clock')} checked={r.hour12} onChange={(v) => save({ regional: { hour12: v } })} /></Row>
    </Card>
  );
}

function Voice() {
  const { me } = useSession();
  const save = useSave();
  const v = me!.settings.voice;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  const sttSupported = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  return (
    <Card title={t('Voice')} desc="Optional. Carino only listens while the microphone button is active, and never records in the background.">
      {!sttSupported && <div className="callout warning small" style={{ marginBottom: 10 }}><Icon name="info" size={16} />{t('Voice input isn’t available in this browser (it works in Chrome and Edge). You can still type.')}</div>}
      <div className="callout small" style={{ marginBottom: 10 }}><Icon name="info" size={16} />{t('In Chrome and Edge, speech-to-text is processed by the browser maker’s online speech service (Google or Microsoft). Read-aloud uses voices installed on your device.')}</div>
      <Row label={t('Enable voice features')}><Switch label={t('Enable voice')} checked={v.enabled} onChange={(x) => save({ voice: { enabled: x } })} /></Row>
      <Row label={t('Speech language')}>
        <select className="select" style={{ width: 200 }} value={v.language} onChange={(e) => save({ voice: { language: e.target.value } })} aria-label={t('Speech language')}>
          {['en-US', 'en-GB', 'en-UG', 'en-KE', 'sw-KE', 'fr-FR', 'lg-UG'].map((l) => <option key={l}>{l}</option>)}
        </select>
      </Row>
      <Row label={t('Read replies aloud automatically')}><Switch label={t('Read replies aloud')} checked={v.speakReplies} onChange={(x) => save({ voice: { speakReplies: x } })} /></Row>
      <Row label={t('Read my brief aloud when I first open Carino each day')}><Switch label={t('Read my brief aloud each day')} checked={!!v.speakBrief} onChange={(x) => save({ voice: { speakBrief: x } })} /></Row>
      <p className="small muted" style={{ marginTop: 8 }}>{t('In voice mode you can say')}{' '}<b>{t('“pause”')}</b> {t('(mutes the microphone),')}{' '}<b>{t('“repeat that”')}</b>, <b>{t('“skip”')}</b>, <b>{t('“read my brief”')}</b> or <b>{t('“stop”')}</b> {t('to end. These are handled on your device, not sent to the AI.')}</p>
      <Row label={t('Voice')}>
        <select className="select" style={{ width: 240 }} value={v.voiceName} onChange={(e) => save({ voice: { voiceName: e.target.value } })} aria-label={t('Voice')}>
          <option value="">{t('Default')}</option>{voices.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.lang})</option>)}
        </select>
        <button className="btn sm" onClick={() => speak('Hello, I’m Carino. This is how I sound.', { lang: v.language, voiceName: v.voiceName })}>{t('Test')}</button>
      </Row>
    </Card>
  );
}

function Privacy() {
  const toast = useToast();
  const confirm = useConfirm();
  const { logout } = useSession();
  const sessions = useData<any>('/auth/sessions');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [deleting, setDeleting] = useState(false);
  if (MOBILE) return <PhonePrivacy />;
  return (
    <>
      <Card title={t('Your data')} desc="Everything is stored in the SQLite database and uploads folder on your Carino server. Nothing is sold or shared. AI requests send the relevant conversation, retrieved memories and attached document text to the AI provider you configured.">
        <Row label={t('Export all data')} desc="A JSON file with your tasks, notes, projects, memories, conversations and settings."><ApiDownload className="btn sm" href="/api/export" name="carino-export.json"><Icon name="download" size={14} />{t('Download export')}</ApiDownload></Row>
        <Row label={t('Offline copy on this device')} desc="Pages you open are cached for offline reading. New tasks, task edits and note edits made offline are queued here and synced when you reconnect; conflicts are shown for review. Signing out clears both."><span className="badge">{t('Read + queued edits')}</span></Row>
        <Row label={t('Sync')} desc="All devices read and write the same server, so changes appear everywhere after a refresh. Offline edits are not queued — make changes when online."><span className="badge success">{t('Server-based')}</span></Row>
      </Card>
      <Card title={t('Signed-in devices')}>
        {sessions.loading ? <Loading rows={2} /> : (
          <ul className="list">{sessions.data?.sessions.map((s: any) => (
            <li key={s.id} className="list-item"><Icon name="user" size={16} /><span className="grow small ellipsis">{s.user_agent || 'Unknown device'} {t('· since')}{' '}{fmtDateTime(s.created_at, { time: false })}</span>{s.current && <span className="badge brand">{t('This device')}</span>}</li>
          ))}</ul>
        )}
        <button className="btn sm" style={{ marginTop: 8 }} onClick={async () => { const r = await post('/auth/sessions/revoke-others'); toast(`Signed out ${r.revoked} other device(s)`); sessions.reload(); }}>{t('Sign out all other devices')}</button>
      </Card>
      <Card title={t('Change password')}>
        <div className="grid two">
          <input className="input" type="password" autoComplete="current-password" placeholder={t('Current password')} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} aria-label={t('Current password')} />
          <input className="input" type="password" autoComplete="new-password" placeholder={t('New password (10+ characters)')} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} aria-label={t('New password')} />
        </div>
        <button className="btn sm primary" style={{ marginTop: 10 }} disabled={!pw.current || pw.next.length < 10} onClick={async () => {
          try { await post('/auth/password', pw); toast(t('Password changed. Other devices were signed out.')); setPw({ current: '', next: '' }); } catch (e: any) { toast(e.message, 'error'); }
        }}>{t('Change password')}</button>
      </Card>
      <Card title={t('Delete account')} desc="Permanently deletes your account and every task, note, document, memory, conversation and setting. This cannot be undone — export first if you want a copy.">
        <button className="btn danger" onClick={async () => { if (await confirm({ title: 'Delete your Carino account?', body: 'You will be asked for your password next.', confirm: 'Continue', danger: true })) setDeleting(true); }}>{t('Delete my account…')}</button>
      </Card>
      {deleting && <DeleteAccount onClose={() => setDeleting(false)} onDeleted={() => { toast(t('Account deleted')); void logout(); }} />}
      <ErrorBox error={sessions.error} />
    </>
  );
}

function PhonePrivacy() {
  const confirm = useConfirm();
  return (
    <>
      <Card title={t('Your data')} desc="Everything — to-dos, reminders, memories, files and chats — is stored on this phone only. Nothing is sold or shared. When you chat, the conversation, relevant memories and attached text are sent to the AI service you chose so it can reply.">
        <Row label={t('Export all data')} desc="A JSON file with your to-dos, reminders, memories, chats and settings, saved to Downloads."><ApiDownload className="btn sm" href="/api/export" name="carino-export.json"><Icon name="download" size={14} />{t('Download export')}</ApiDownload></Row>
      </Card>
      <Card title={t('Backup & restore')} desc="Your data isn’t in Android’s own phone backup (it would include the key to your sign-ins). Make your own encrypted backups here instead.">
        <BackupCard />
      </Card>
      <Card title={t('Erase everything')} desc="Deletes every to-do, reminder, memory, file, chat, setting and your AI key from this phone. This cannot be undone — export first if you want a copy.">
        <button className="btn danger" onClick={async () => {
          if (await confirm({ title: 'Erase everything on this phone?', body: 'Carino starts again from the beginning.', confirm: 'Erase everything', danger: true })) { await post('/device/reset'); location.replace('/'); }
        }}>{t('Erase everything…')}</button>
      </Card>
    </>
  );
}

function DeleteAccount({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={t('Delete account permanently')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn danger solid" disabled={typed !== 'DELETE' || !password} onClick={async () => {
        try { await api('/auth/delete-account', { method: 'POST', body: { password, confirm: 'DELETE' } }); onDeleted(); } catch (e: any) { setError(e.message); }
      }}>{t('Delete everything')}</button>
    </>}>
      <div className="stack">
        <input className="input" type="password" autoComplete="current-password" placeholder={t('Your password')} value={password} onChange={(e) => setPassword(e.target.value)} aria-label={t('Password')} />
        <input className="input" placeholder={t('Type DELETE to confirm')} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t('Type DELETE to confirm')} />
        {error && <div className="callout danger small">{error}</div>}
      </div>
    </Modal>
  );
}
