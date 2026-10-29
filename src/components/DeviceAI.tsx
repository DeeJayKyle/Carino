import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Loading, useToast } from './ui';
import { api, post } from '../lib/api';
import { useSession } from '../lib/session';
import { openExternal } from '../../mobile/native';

interface Preset { id: string; label: string; free: string; baseUrl: string; model: string; vision: boolean; keyUrl: string; transcribe?: { model: string } }

/**
 * Phone app only: which AI service Carino talks to, and the key for it. The key is saved on
 * this phone and sent only to that service. Free options come first.
 */
export function DeviceAI({ onSaved, compact = false }: { onSaved?: () => void; compact?: boolean }) {
  const toast = useToast();
  const { refresh } = useSession();
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<any>('/device/config').then((r) => {
      setPresets(r.presets);
      setForm({ ...r.config, provider: r.config.provider ?? 'groq' });
    }).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  if (!presets || !form) return <Loading rows={3} />;
  const p = presets.find((x) => x.id === form.provider) ?? presets[0];
  const set = (patch: any) => {
    setTest(null);
    setForm((f: any) => ({ ...f, ...patch }));
  };

  const save = async () => {
    setBusy(true);
    setTest(null);
    try {
      await api('/device/config', { method: 'PUT', body: { ...form, model: form.model || undefined } });
      await refresh();
      const r = await post<any>('/ai/test', {}).catch((e) => ({ results: [{ ok: false, error: e.message }] }));
      const res = r.results?.find((x: any) => x.ok) ?? r.results?.[0];
      setTest(res?.ok ? { ok: true, text: `Connected to ${p.label} · ${res.model}` } : { ok: false, text: res?.error ?? 'Could not reach the AI service.' });
      if (res?.ok) onSaved?.();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack device-ai">
      <div className="preset-grid" role="radiogroup" aria-label="AI service">
        {presets.map((x) => (
          <button key={x.id} type="button" role="radio" aria-checked={form.provider === x.id} className={`preset ${form.provider === x.id ? 'on' : ''}`}
            onClick={() => set({ provider: x.id, model: '', baseUrl: x.id === 'custom' ? form.baseUrl : '' })}>
            <span className="preset-name">{x.label}{x.id !== 'anthropic' && x.id !== 'custom' && <span className="badge success">Free</span>}</span>
            {!compact && <span className="tiny muted">{x.free}</span>}
          </button>
        ))}
      </div>
      {p.keyUrl && (
        <p className="small muted">
          Get a key: <button type="button" className="linklike" onClick={() => openExternal(p.keyUrl)}>{p.keyUrl.replace('https://', '')}</button>. Sign in, create a key, copy it and paste it below.
        </p>
      )}
      {p.id === 'custom' && (
        <div className="field"><label htmlFor="dai-url">Address</label>
          <input id="dai-url" className="input" inputMode="url" placeholder={p.baseUrl} value={form.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} /></div>
      )}
      <div className="field"><label htmlFor="dai-key">API key{p.id === 'custom' ? ' (if needed)' : ''}</label>
        <input id="dai-key" className="input" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your key" value={form.apiKey ?? ''} onChange={(e) => set({ apiKey: e.target.value })} /></div>
      <details>
        <summary className="small">More options</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          <div className="field"><label htmlFor="dai-model">Model</label>
            <input id="dai-model" className="input" placeholder={p.model} value={form.model ?? ''} onChange={(e) => set({ model: e.target.value })} /></div>
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
      {test && <div className={`callout small ${test.ok ? 'success' : 'warning'}`} role="status"><Icon name={test.ok ? 'check' : 'info'} size={16} />{test.text}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || (!form.apiKey && p.id !== 'custom')} onClick={save}>{busy ? 'Checking…' : 'Save and test'}</button>
      </div>
      <p className="faint tiny">Your key stays on this phone and is sent only to {p.label}. Messages you send go to {p.label} to be answered; everything else stays on the phone.</p>
    </div>
  );
}
