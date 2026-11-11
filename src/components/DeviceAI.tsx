import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Loading, useToast } from './ui';
import { api, post } from '../lib/api';
import { useSession } from '../lib/session';
import { openExternal } from '../../mobile/native';

interface SpeedResult { model: string; ok: boolean; firstMs?: number; totalMs?: number; error?: string }
interface FreeModel { id: string; label: string; family?: string; vision?: boolean }
interface Preset { id: string; label: string; free: string; baseUrl: string; model: string; models: FreeModel[]; vision: boolean; keyUrl: string; hidden?: boolean; ownAddress?: boolean; onDevice?: boolean; paid?: boolean; api?: string; transcribe?: { model: string } }

const OTHER = '__other__';

/**
 * Phone app only: which AI service Carino talks to, which of its free models, and the key.
 * The key is saved on this phone and sent only to that service. Services and models are
 * listed best first; "Check my key" asks the service which models the key can really use.
 */
const VAULT_TEXT: Record<string, string> = {
  'android-keystore': 'Keys are encrypted and locked with your phone’s secure key store (Android Keystore).',
  'windows-dpapi': 'Keys are encrypted and locked to your Windows account on this PC.',
  browser: 'Keys are encrypted with a key this browser keeps and can’t reveal.',
};

export function DeviceAI({ onSaved, compact = false }: { onSaved?: () => void; compact?: boolean }) {
  const toast = useToast();
  const { refresh } = useSession();
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  /** What the service said this key can use; null until checked. */
  const [live, setLive] = useState<{ provider: string; ids: string[]; error?: string } | null>(null);
  const [typing, setTyping] = useState(false);
  /** Speed test results for this service, fastest first; null until run. */
  const [speed, setSpeed] = useState<{ provider: string; results: SpeedResult[] } | null>(null);
  const [timing, setTiming] = useState(false);
  /** On-phone AI: whether the chosen model is downloaded. */
  const [localReady, setLocalReady] = useState(false);
  /** How saved keys are protected on this device, and whether older ones couldn't be opened. */
  const [vaultInfo, setVaultInfo] = useState<{ protection?: string; keysUnreadable?: boolean }>({});

  useEffect(() => {
    api<any>('/device/config').then((r) => {
      setPresets(r.presets);
      setVaultInfo({ protection: r.protection, keysUnreadable: r.keysUnreadable });
      setForm({ ...r.config, provider: r.config.provider ?? r.presets[0].id });
    }).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  if (!presets || !form) return <Loading rows={3} />;
  const shown = presets.filter((x) => !x.hidden || x.id === form.provider);
  const p = presets.find((x) => x.id === form.provider) ?? presets[0];
  const set = (patch: any) => {
    setTest(null);
    setForm((f: any) => ({ ...f, ...patch }));
  };
  const liveIds = live?.provider === p.id && live.ids.length ? new Set(live.ids) : null;
  const works = (id: string) => (liveIds ? liveIds.has(id) : undefined);
  // Free models the service offers that aren't in our list (OpenRouter's change often; a PC has its own).
  const extra = liveIds ? [...liveIds].filter((id) => !p.models.some((m) => m.id === id) && (p.id === 'openrouter' || p.ownAddress)) : [];
  const current = form.model || p.model;
  const inList = p.models.some((m) => m.id === current) || extra.includes(current);

  const check = async () => {
    setBusy(true);
    try {
      const r = await api<any>('/device/models', { method: 'POST', body: { provider: p.id, apiKey: form.apiKey, baseUrl: form.baseUrl } });
      setLive({ provider: p.id, ids: r.models ?? [], error: r.error });
      // Keep the choice if it works; otherwise move to the best free model that does.
      const ids = new Set<string>(r.models ?? []);
      if (ids.size && !ids.has(current)) {
        const best = p.models.find((m) => ids.has(m.id))?.id ?? (p.ownAddress || p.id === 'openrouter' ? [...ids][0] : undefined);
        if (best) set({ model: best });
      }
    } catch (e: any) {
      setLive({ provider: p.id, ids: [], error: e.message });
    } finally {
      setBusy(false);
    }
  };

  const runSpeed = async () => {
    setTiming(true);
    setSpeed(null);
    try {
      // Only models the key can use (if checked), else the whole free list.
      const models = liveIds ? [...p.models.map((m) => m.id).filter((id) => liveIds.has(id)), ...extra].slice(0, 8) : undefined;
      const r = await api<{ results: SpeedResult[] }>('/device/speedtest', { method: 'POST', body: { provider: p.id, apiKey: form.apiKey, baseUrl: form.baseUrl, models } });
      setSpeed({ provider: p.id, results: r.results });
      const best = r.results.find((x) => x.ok);
      if (best) {
        set({ model: best.model });
        setTyping(false);
      }
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setTiming(false);
    }
  };
  const label = (id: string) => p.models.find((m) => m.id === id)?.label.replace(/ — .*/, '') ?? id;
  const secs = (ms?: number) => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`);

  const save = async () => {
    setBusy(true);
    setTest(null);
    try {
      await api('/device/config', { method: 'PUT', body: { ...form, model: form.model || undefined } });
      await refresh();
      const r = await post<any>('/ai/test', {}).catch((e) => ({ results: [{ ok: false, error: e.message }] }));
      const res = r.results?.find((x: any) => x.ok) ?? r.results?.[0];
      setTest(res?.ok ? { ok: true, text: `Connected to ${p.label} · ${res.model}${res.model !== current ? ` (${current} wasn’t available, so Carino used the next free model)` : ''}` } : { ok: false, text: res?.error ?? 'Could not reach the AI service.' });
      if (res?.ok) onSaved?.();
      else if (!liveIds) void check();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const mark = (id: string) => (works(id) === true ? ' ✓' : works(id) === false ? (p.ownAddress ? ' — not installed' : ' — not available to this key') : '');

  return (
    <div className="stack device-ai">
      {vaultInfo.keysUnreadable && <div className="callout warning small"><Icon name="alert" size={16} />Your saved keys couldn’t be unlocked on this device (its secure key store was reset). Please enter them again.</div>}
      <div className="preset-grid" role="radiogroup" aria-label="AI service">
        {shown.map((x, i) => (
          <button key={x.id} type="button" role="radio" aria-checked={form.provider === x.id} className={`preset ${form.provider === x.id ? 'on' : ''}`}
            onClick={() => { set({ provider: x.id, model: '', baseUrl: x.ownAddress ? form.baseUrl : '' }); setLive(null); setTyping(false); }}>
            <span className="preset-name">{x.label}{!x.hidden && (x.paid ? <span className="badge warn">Paid</span> : <span className="badge success">{i === 0 ? 'Free · best' : 'Free'}</span>)}</span>
            {!compact && <span className="tiny muted">{x.free}</span>}
          </button>
        ))}
      </div>
      {p.onDevice && <LocalModels value={current} onChange={(model) => set({ model })} onReady={setLocalReady} />}
      {p.keyUrl && (
        <p className="tiny muted"><Icon name="lock" size={12} /> {VAULT_TEXT[vaultInfo.protection ?? ''] ?? 'Keys are stored encrypted on this device.'} Only the last 4 characters are ever shown.</p>
      )}
      {p.keyUrl && (
        <p className="small muted">
          Get a free key: <button type="button" className="linklike" onClick={() => openExternal(p.keyUrl)}>{p.keyUrl.replace('https://', '')}</button>. Sign in, create a key, copy it and paste it below.
        </p>
      )}
      {p.ownAddress && !p.onDevice && (
        <div className="field"><label htmlFor="dai-url">Address</label>
          <input id="dai-url" className="input" inputMode="url" placeholder={p.baseUrl} value={form.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} /></div>
      )}
      {!p.onDevice && (
        <div className="field"><label htmlFor="dai-key">API key{p.ownAddress ? ' (if needed)' : ''}</label>
          <input id="dai-key" className="input" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your key" value={form.apiKey ?? ''} onChange={(e) => set({ apiKey: e.target.value })} /></div>
      )}
      {!p.hidden && !p.onDevice && (
        <div className="field">
          <label htmlFor="dai-model">Model <span className="faint">(free, best first)</span></label>
          {typing || (!inList && !!form.model) ? (
            <div className="row">
              <input id="dai-model" className="input grow" placeholder={p.model} value={form.model ?? ''} onChange={(e) => set({ model: e.target.value })} autoFocus={typing} />
              <button type="button" className="btn sm" onClick={() => { setTyping(false); set({ model: '' }); }}>List</button>
            </div>
          ) : (
            <select id="dai-model" className="select" value={current} onChange={(e) => (e.target.value === OTHER ? (setTyping(true), set({ model: '' })) : set({ model: e.target.value }))}>
              {p.models.map((m) => (
                <option key={m.id} value={m.id} disabled={works(m.id) === false}>
                  {m.label}{m.family && !m.label.includes(m.family) ? ` (${m.family})` : ''}{m.vision ? ' · photos' : ''}{mark(m.id)}
                </option>
              ))}
              {extra.length > 0 && <optgroup label={p.ownAddress ? 'On your computer' : 'Other free models right now'}>{extra.map((id) => <option key={id} value={id}>{id} ✓</option>)}</optgroup>}
              <option value={OTHER}>Type a model name…</option>
            </select>
          )}
          <div className="row wrap" style={{ marginTop: 6 }}>
            <button type="button" className="btn sm" disabled={busy || timing || (!form.apiKey && !p.ownAddress)} onClick={check}><Icon name="refresh" size={14} />Check my key</button>
            <button type="button" className="btn sm" disabled={busy || timing || (!form.apiKey && !p.ownAddress)} onClick={runSpeed}><Icon name="clock" size={14} />{timing ? 'Timing each model…' : 'Test speed'}</button>
            {live?.provider === p.id && (
              <span className="tiny muted">{live.error ?? (live.ids.length ? `${p.models.filter((m) => works(m.id)).length + extra.length} free model(s) available to this key` : 'The service didn’t list its models; the list above is used as is.')}</span>
            )}
          </div>
          {speed?.provider === p.id && (
            <div className="speed-results" role="status" aria-live="polite">
              {speed.results.length === 0 ? <p className="tiny muted">Nothing to time.</p> : (
                <ol className="list">
                  {speed.results.map((r, i) => (
                    <li key={r.model} className={`speed-row ${r.ok ? '' : 'failed'}`}>
                      <span className="grow ellipsis">{label(r.model)}{i === 0 && r.ok ? <span className="badge success" style={{ marginLeft: 6 }}>Fastest · chosen</span> : null}</span>
                      <span className="tiny muted">{r.ok ? `starts in ${secs(r.firstMs)} · done in ${secs(r.totalMs)}` : r.error}</span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="faint tiny">Timed from this phone just now. Speeds change during the day; tap Save and test to keep the choice.</p>
            </div>
          )}
          {!p.ownAddress && <p className="faint tiny">If a model is retired, busy or over its free limit, Carino switches to the next one in this list on its own.</p>}
        </div>
      )}
      <details>
        <summary className="small">More options</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          {p.id !== 'groq' && (
            <div className="field"><label htmlFor="dai-groq">Groq key for voice notes (free, optional)</label>
              <input id="dai-groq" className="input" type="password" autoComplete="off" placeholder="Turns Telegram voice notes into text" value={form.groqKey ?? ''} onChange={(e) => set({ groqKey: e.target.value })} /></div>
          )}
          <div className="field"><label htmlFor="dai-brave">Brave Search key for web research (free tier, optional)</label>
            <input id="dai-brave" className="input" type="password" autoComplete="off" value={form.braveKey ?? ''} onChange={(e) => set({ braveKey: e.target.value })} /></div>
          <div className="field"><label htmlFor="dai-searx">…or a SearXNG address (free, optional)</label>
            <input id="dai-searx" className="input" inputMode="url" placeholder="https://searx.example.org" value={form.searxngUrl ?? ''} onChange={(e) => set({ searxngUrl: e.target.value })} /></div>
        </div>
      </details>
      {test && <div className={`callout small ${test.ok ? 'success' : 'warning'}`} role="status"><Icon name={test.ok ? 'check' : 'info'} size={16} /><span style={{ overflowWrap: 'anywhere' }}>{test.text.slice(0, 400)}</span></div>}
      <div className="row">
        <button className="btn primary" disabled={busy || (p.onDevice ? !localReady : !form.apiKey && !p.ownAddress)} onClick={() => save()}>{busy ? (p.onDevice ? 'Starting the model…' : 'Checking…') : 'Save and test'}</button>
      </div>
      <p className="faint tiny">{p.onDevice
        ? 'Everything stays on this phone, including your messages. The first reply after opening the app takes longer while the model starts.'
        : `Your key stays on this phone and is sent only to ${p.label}. Messages you send go to ${p.label} to be answered; everything else stays on the phone.`}</p>
    </div>
  );
}

interface LocalInfo {
  models: { id: string; label: string; note: string; size: number; downloaded: boolean }[];
  status: { state: string; model?: string; loaded?: number; total?: number; error?: string; threads?: number };
  threads: number;
  storage: { free: number | null };
}

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/** The AI models that can run on this phone: download once, pick one, remove to free space. */
function LocalModels({ value, onChange, onReady }: { value: string; onChange: (id: string) => void; onReady: (ok: boolean) => void }) {
  const toast = useToast();
  const [info, setInfo] = useState<LocalInfo | null>(null);
  const load = () => api<LocalInfo>('/device/local').then(setInfo).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const downloading = info?.status.state === 'downloading';
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [downloading]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = info?.models.find((m) => m.id === value);
  useEffect(() => { onReady(!!chosen?.downloaded); }, [chosen?.downloaded, onReady]);
  // Pick a downloaded model if the chosen one isn't.
  useEffect(() => {
    if (!info || chosen?.downloaded) return;
    const have = info.models.find((m) => m.downloaded);
    if (have) onChange(have.id);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (body: any) => {
    try {
      setInfo(await api<LocalInfo>('/device/local', { method: 'POST', body }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  if (!info) return <Loading rows={2} />;
  const s = info.status;
  return (
    <div className="field local-models">
      <span className="label">Model on this phone</span>
      <div role="radiogroup" aria-label="Model on this phone" className="stack" style={{ gap: 8 }}>
        {info.models.map((m) => {
          const mine = s.model === m.id;
          const pct = mine && downloading && s.total ? Math.floor(((s.loaded ?? 0) / s.total) * 100) : 0;
          const tooBig = info.storage.free != null && !m.downloaded && info.storage.free < m.size * 1.1;
          return (
            <div key={m.id} className={`local-model card ${value === m.id && m.downloaded ? 'on' : ''}`}>
              <button type="button" role="radio" aria-checked={value === m.id} disabled={!m.downloaded} className="lm-pick" onClick={() => onChange(m.id)}>
                <span className="lm-dot" aria-hidden="true" />
                <span className="grow">
                  <b>{m.label}</b>
                  <span className="tiny muted">{gb(m.size)} · {m.note}</span>
                </span>
              </button>
              {mine && downloading ? (
                <div className="lm-progress">
                  <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Downloading ${m.label}`}><span style={{ width: `${pct}%` }} /></span>
                  <span className="row"><span className="tiny muted grow">{gb(s.loaded ?? 0)} of {gb(s.total ?? m.size)} · keep Carino open</span>
                    <button type="button" className="btn ghost sm" onClick={() => act({ action: 'cancel' })}>Cancel</button></span>
                </div>
              ) : m.downloaded ? (
                <div className="row lm-actions"><span className="badge success"><Icon name="check" size={12} /> On this phone</span><span className="grow" />
                  <button type="button" className="btn ghost sm" onClick={() => act({ action: 'remove', model: m.id })} aria-label={`Remove ${m.label}`}><Icon name="trash" size={14} />Remove</button></div>
              ) : (
                <div className="row lm-actions">
                  <button type="button" className="btn sm" disabled={downloading || tooBig} onClick={() => act({ action: 'download', model: m.id })}><Icon name="download" size={14} />Download {gb(m.size)}</button>
                  {tooBig && <span className="tiny warn-text">Not enough free space</span>}
                </div>
              )}
              {s.state === 'error' && s.model === m.id && <p className="tiny" style={{ color: 'var(--danger)' }}>{s.error}</p>}
            </div>
          );
        })}
      </div>
      <p className="faint tiny">Use Wi-Fi for the download. After that it works with no internet. {info.threads > 1 ? `Uses ${info.threads} processor cores.` : ''}</p>
    </div>
  );
}
