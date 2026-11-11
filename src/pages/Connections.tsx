import { useEffect, useState, type ReactNode } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, Seg, Switch, useConfirm, useToast } from '../components/ui';
import { useData } from '../lib/hooks';
import { api, del, patch, post } from '../lib/api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { fmtDateTime } from '../lib/format';

/**
 * Everything Carino is connected to, and how it picks AI models: services and local AI it found,
 * each model's tested abilities, speed and cost, the choice per job, spending limits, and signed-in
 * accounts. Each can be checked, turned off or disconnected here.
 */
export default function Connections() {
  const toast = useToast();
  const { me, refresh } = useSession();
  const models = useData<any>('/models');
  const conns = useData<any>('/connections');
  const [checking, setChecking] = useState(false);
  const settings = me!.settings.ai as any;
  const saveAi = async (p: any) => {
    try {
      await patch('/settings', { ai: p });
      await refresh();
      models.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const checkAll = async () => {
    setChecking(true);
    try {
      const r = await post<any>('/connections/refresh', {});
      toast(r.result.problems.length ? `Checked. ${r.result.problems.length} need${r.result.problems.length === 1 ? 's' : ''} attention.` : 'Everything is connected');
      conns.reload();
      models.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setChecking(false);
    }
  };
  const reload = () => { conns.reload(); models.reload(); };
  return (
    <Shell title="Connections" actions={<button className="btn sm" disabled={checking} onClick={checkAll}><Icon name="refresh" size={15} />{checking ? 'Checking…' : 'Check all'}</button>}>
      <div className="page connections">
        <div className="page-head"><div>
          <h1>Connections</h1>
          <p className="sub">The AI services, local AI and accounts Carino may use. Carino only uses what you set up here, keeps sign-ins fresh by itself, and never sends private content to an online AI.</p>
        </div></div>
        <ErrorBox error={models.error ?? conns.error} retry={reload} />
        {!models.data || !conns.data ? <Loading rows={4} /> : (
          <>
            <AiServices data={models.data} settings={settings} saveAi={saveAi} reload={reload} />
            <FoundHere reload={reload} />
            <Choices data={models.data} settings={settings} saveAi={saveAi} />
            <Models data={models.data} settings={settings} saveAi={saveAi} reload={reload} />
            <Spending settings={settings} saveAi={saveAi} />
            <Accounts data={conns.data} reload={reload} />
          </>
        )}
      </div>
    </Shell>
  );
}

const STATUS: Record<string, [string, string]> = {
  ok: ['Connected', 'success'], offline: ['Not reachable', 'warn'], needs_sign_in: ['Needs you to sign in again', 'danger'],
  error: ['Problem', 'danger'], unchecked: ['Not checked yet', ''],
};
function StatusChip({ status, detail, at }: { status: string; detail?: string | null; at?: string | null }) {
  const [label, tone] = STATUS[status] ?? [status, ''];
  return <span className={`badge ${tone}`} title={[detail, at ? `Checked ${fmtDateTime(at)}` : ''].filter(Boolean).join(' · ')}>{label}</span>;
}

function Section({ title, sub, action, children, id }: { title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="card pad" aria-label={title} id={id} style={{ marginBottom: 16 }}>
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>{title}</h2>{action}</div>
      {sub && <p className="small muted" style={{ marginTop: 4 }}>{sub}</p>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </section>
  );
}

// ---- AI services --------------------------------------------------------------------------

function AiServices({ data, settings, saveAi, reload }: { data: any; settings: any; saveAi: (p: any) => void; reload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const device = useData<any>('/device/connections');
  const onDevice = !device.error;
  const check = async (id: string) => {
    setBusy(id);
    try {
      const r = (await post<any>('/models/refresh', { conn_id: id })).results[0];
      toast(r.ok ? `${r.models} models available` : r.error, r.ok ? undefined : 'error');
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const approvePaid = async (c: any, on: boolean) => {
    if (on && !(await confirm({
      title: `Allow paid use of ${c.label}?`,
      body: `Carino may then pick ${c.label}’s models when they suit a message best, and each use costs money on your ${c.label} account. You can set a spending limit below; at the limit, Carino stops using paid models.`,
      confirm: 'Allow',
    }))) return;
    saveAi({ approvedPaid: on ? [...new Set([...settings.approvedPaid, c.id])] : settings.approvedPaid.filter((x: string) => x !== c.id) });
  };
  const remove = async (c: any) => {
    if (!(await confirm({ title: `Remove ${c.label}?`, body: 'Carino stops using it and deletes its saved key from this device.', confirm: 'Remove' }))) return;
    try {
      await del(`/device/connections/${c.id}`);
      toast(`Removed ${c.label}`);
      device.reload();
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const extras = new Set((device.data?.connections ?? []).map((x: any) => x.id));
  return (
    <Section title="AI services" sub="Where Carino’s answers come from. Your main service is set in Settings → AI; add more here so Carino can pick the best one for each message."
      action={onDevice ? <button className="btn primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} />Add a service</button> : undefined}>
      {!data.connections.length ? <Empty icon="sparkle" title="No AI service yet"><Link to="/settings#ai">Set one up</Link></Empty> : (
        <ul className="list divided">
          {data.connections.map((c: any) => (
            <li key={c.id} className="list-item conn-row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span className="grow" style={{ minWidth: 0 }}>
                <b>{c.label}</b>{c.main && <span className="badge" style={{ marginLeft: 6 }}>Main</span>}
                <span className="tiny muted" style={{ display: 'block' }}>
                  {c.local ? 'On your devices — content stays with you' : 'Online'} · {c.billing === 'free' ? 'Free' : c.billing === 'paid' ? 'Paid' : 'May cost money'} · {c.models} model{c.models === 1 ? '' : 's'}
                  {c.api === 'responses' ? ' · Responses API' : ''}
                </span>
                {c.detail && c.status !== 'ok' && <span className="tiny warn-text" style={{ display: 'block' }}>{c.detail}</span>}
              </span>
              <StatusChip status={c.status} detail={c.detail} at={c.checked_at} />
              {c.billing !== 'free' && !c.main && (
                <Switch label={`Allow paid use of ${c.label}`} checked={settings.approvedPaid.includes(c.id)} onChange={(v) => approvePaid(c, v)} />
              )}
              <button className="btn ghost sm" disabled={busy === c.id} onClick={() => check(c.id)}><Icon name="refresh" size={14} />{busy === c.id ? 'Checking…' : 'Check'}</button>
              {extras.has(c.id) && <button className="btn ghost sm" aria-label={`Remove ${c.label}`} onClick={() => remove(c)}><Icon name="x" size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
      {adding && <AddService onClose={() => setAdding(false)} onAdded={() => { setAdding(false); device.reload(); reload(); }} />}
    </Section>
  );
}

function AddService({ onClose, onAdded, preset: initial, baseUrl: initialUrl }: { onClose: () => void; onAdded: () => void; preset?: string; baseUrl?: string }) {
  const toast = useToast();
  const [presets, setPresets] = useState<any[] | null>(null);
  const [preset, setPreset] = useState(initial ?? '');
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(initialUrl ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<any>('/device/config').then((r) => {
      const list = r.presets.filter((p: any) => !p.hidden);
      setPresets(list);
      if (!initial) setPreset(list[0]?.id ?? '');
    }).catch(() => setPresets([]));
  }, [initial]);
  const p = presets?.find((x) => x.id === preset);
  const add = async () => {
    setSaving(true);
    try {
      const r = await post<any>('/device/connections', { preset, apiKey: key || undefined, baseUrl: p?.ownAddress ? url : undefined });
      toast(r.check?.ok ? `Added — ${r.check.models} models found` : `Added. ${r.check?.error ?? ''}`);
      onAdded();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="card pad add-service" style={{ marginTop: 12 }}>
      {!presets ? <Loading rows={2} /> : (
        <div className="stack">
          <div className="field">
            <label htmlFor="svc">Service</label>
            <select id="svc" className="select" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {presets.map((x) => <option key={x.id} value={x.id}>{x.label}{x.paid ? ' (paid)' : x.onDevice || x.ownAddress ? ' (on your devices)' : ' (free)'}</option>)}
            </select>
            {p && <div className="hint">{p.free}</div>}
          </div>
          {p?.ownAddress && <div className="field"><label htmlFor="svc-url">Address</label><input id="svc-url" className="input" placeholder="http://localhost:11434/v1" value={url} onChange={(e) => setUrl(e.target.value)} /></div>}
          {p?.keyUrl && !p.ownAddress && (
            <div className="field">
              <label htmlFor="svc-key">Key</label>
              <input id="svc-key" className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" />
              <div className="hint">Get one at {p.keyUrl.replace('https://', '')}. It’s checked, then stored encrypted on this device; only its last 4 characters are shown again.</div>
            </div>
          )}
          {p?.paid && <div className="callout small"><Icon name="info" size={16} />Paid service: Carino won’t use it until you allow paid use, and you can set a spending limit.</div>}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={saving || !preset || (!!p?.keyUrl && !p.ownAddress && !key.trim()) || (!!p?.ownAddress && !url.trim())} onClick={add}>{saving ? 'Checking…' : 'Add'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FoundHere({ reload }: { reload: () => void }) {
  const toast = useToast();
  const added = useData<any>('/device/connections');
  const isAdded = (f: any) => (added.data?.connections ?? []).some((x: any) => (f.kind === 'phone' ? x.preset === 'phone' : x.baseUrl === f.baseUrl));
  const [found, setFound] = useState<any[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const look = async () => {
    setLooking(true);
    try {
      setFound((await api<any>('/device/discover')).found);
    } catch (e: any) {
      if (e.status === 404) setUnsupported(true);
      else toast(e.message, 'error');
    } finally {
      setLooking(false);
    }
  };
  useEffect(() => { void look(); }, []);
  const add = async (f: any) => {
    try {
      const r = await post<any>('/device/connections', f.kind === 'phone' ? { preset: 'phone' } : { preset: 'custom', baseUrl: f.baseUrl, label: `${f.label} (${f.where})` });
      toast(r.check?.ok ? `Added ${f.label} — ${r.check.models} models` : `Added ${f.label}`);
      added.reload();
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  if (unsupported) return null;
  return (
    <Section title="AI on your devices" sub="Carino looks only on this device and the PC you paired with, for Ollama, LM Studio and similar servers — never across your network. Nothing is added until you choose."
      action={<button className="btn ghost sm" disabled={looking} onClick={look}><Icon name="search" size={14} />{looking ? 'Looking…' : 'Look again'}</button>}>
      {!found ? <Loading rows={1} /> : !found.length ? <p className="small muted">None found. If you use Ollama or LM Studio, start it and look again.</p> : (
        <ul className="list divided">
          {found.map((f) => (
            <li key={f.kind + f.baseUrl} className="list-item" style={{ flexWrap: 'wrap' }}>
              <Icon name="lock" size={16} />
              <span className="grow" style={{ minWidth: 0 }}>
                <b>{f.label}</b> <span className="tiny muted">on {f.where}</span>
                <span className="tiny muted" style={{ display: 'block' }}>{f.models.length} model{f.models.length === 1 ? '' : 's'}{f.models.length ? `: ${f.models.slice(0, 4).map((m: any) => m.id).join(', ')}${f.models.length > 4 ? '…' : ''}` : ''}</span>
                {f.blocked && <span className="tiny warn-text" style={{ display: 'block' }}>{f.blocked}</span>}
              </span>
              {isAdded(f) ? <span className="badge success"><Icon name="check" size={11} /> Added</span> : <button className="btn sm" onClick={() => add(f)}><Icon name="plus" size={14} />Add</button>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---- Choosing models -----------------------------------------------------------------------

const ROLES: [string, string, string][] = [
  ['everyday', 'Everyday chat', 'Quick questions, to-dos, reminders'],
  ['complex', 'Complex tasks', 'Reports, plans, analysis, long chats'],
  ['vision', 'Photos', 'Receipts, documents and pictures you attach'],
  ['offline', 'Offline', 'When there’s no internet'],
];

function Choices({ data, settings, saveAi }: { data: any; settings: any; saveAi: (p: any) => void }) {
  const usable = data.models.filter((m: any) => !m.blocked);
  return (
    <Section title="How Carino picks a model" sub="For each message Carino picks among the models you allow, by what the message needs, privacy, speed and your budget. Private chats and local-only content only ever go to models on your devices.">
      <div className="stack">
        <div className="row"><span className="grow">Pick the model for each message automatically</span><Switch label="Pick the model automatically" checked={settings.autoSelect} onChange={(v) => saveAi({ autoSelect: v })} /></div>
        <div className="row wrap"><span className="grow">Prefer</span>
          <Seg label="Prefer" value={settings.prefer} onChange={(v) => saveAi({ prefer: v })} options={[{ value: 'privacy', label: 'Privacy' }, { value: 'balanced', label: 'Balanced' }, { value: 'speed', label: 'Speed' }]} />
        </div>
        <div className="row"><span className="grow">Keep everything on my devices (local models only)</span><Switch label="Local models only" checked={!!settings.localOnly} onChange={(v) => saveAi({ localOnly: v })} /></div>
        {ROLES.map(([role, label, hint]) => {
          const rec = data.recommendations[role];
          const list = usable.filter((m: any) => (role !== 'vision' || m.caps.vision !== false) && (role !== 'offline' || m.local));
          return (
            <div key={role} className="field role-pick">
              <label htmlFor={`role-${role}`}>{label} <span className="tiny muted">— {hint}</span></label>
              <select id={`role-${role}`} className="select" value={settings.roles?.[role] ?? ''} onChange={(e) => saveAi({ roles: { ...settings.roles, [role]: e.target.value || undefined } })}>
                <option value="">Automatic{rec ? ` (now: ${rec.label})` : ''}</option>
                {list.map((m: any) => <option key={m.ref} value={m.ref}>{m.label ?? m.model} · {m.connection}{m.paid === false ? ' · free' : ''}{m.local ? ' · on device' : ''}</option>)}
              </select>
              <div className="hint">{rec ? <>Recommended: <b>{rec.label}</b> ({rec.why})</> : role === 'offline' ? 'No model on this device yet — add Ollama or the on-phone model to keep working offline.' : role === 'vision' ? 'No tested model reads photos yet — test one below.' : 'Test your models below to get a recommendation.'}</div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function Models({ data, settings, saveAi, reload }: { data: any; settings: any; saveAi: (p: any) => void; reload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [pricing, setPricing] = useState<{ ref: string; input: string; output: string } | null>(null);
  const test = async (m: any, confirmCost = false): Promise<void> => {
    setBusy(m.ref);
    try {
      const r = (await post<any>('/models/test', { ref: m.ref, confirm_cost: confirmCost })).result;
      toast(r.ok ? `${m.model}: tested` : `${m.model}: ${r.error}`, r.ok ? undefined : 'error');
      reload();
    } catch (e: any) {
      if (e.status === 409 && e.data?.needs_confirmation) {
        setBusy('');
        const est = e.data.estimate_usd;
        if (await confirm({ title: `Test ${m.model}?`, body: `This model costs money. A test uses about ${est !== null && est !== undefined ? `$${est.toFixed(4)}` : 'a few thousand tokens (price unknown)'} of your ${m.connection} credit.`, confirm: 'Test it' })) return test(m, true);
        return;
      }
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const savePrice = async () => {
    if (!pricing) return;
    const i = Number(pricing.input);
    const o = Number(pricing.output);
    if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return toast('Enter two prices, like 0.25 and 2', 'error');
    try {
      await post('/models/price', { ref: pricing.ref, input: i, output: o });
      setPricing(null);
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const list: any[] = data.models.filter((m: any) => showAll || m.status !== 'unavailable');
  const shown = showAll ? list : list.slice(0, 30);
  return (
    <Section title="Models" sub="Tested for real: a reply, using tools, pulling out details, a small reasoning step and reading a photo. Free and local models can be tested any time; paid ones show the cost first.">
      {!list.length ? <p className="small muted">No models yet.</p> : (
        <ul className="list divided model-list">
          {shown.map((m) => {
            const off = settings.disabledModels.includes(m.ref);
            return (
              <li key={m.ref} className="list-item" style={{ flexWrap: 'wrap', alignItems: 'flex-start', opacity: off ? 0.6 : 1 }}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <b className="ellipsis" style={{ display: 'block' }}>{m.label ?? m.model}{m.main && <span className="badge" style={{ marginLeft: 6 }}>Main</span>}</b>
                  <span className="tiny muted">{m.connection}</span>
                  <span className="model-badges">
                    {m.local && <span className="badge success">On device</span>}
                    {m.paid === false ? <span className="badge success">Free</span> : m.price_in !== null ? <span className="badge">${m.price_in}/${m.price_out} per M</span> : <span className="badge warn">{m.paid ? 'Paid' : 'May cost'} · price unknown</span>}
                    {m.caps.vision && <span className="badge">Photos</span>}
                    {m.caps.tools === true && <span className="badge">Tools</span>}
                    {m.caps.tools === false && <span className="badge warn">No tools</span>}
                    {m.caps.api === 'responses' && <span className="badge">Responses API</span>}
                    {m.quality !== null && <span className="badge">{Math.round(m.quality * 100)}%</span>}
                    {m.latency_ms && <span className="badge">{(m.latency_ms / 1000).toFixed(1)}s</span>}
                    {m.status === 'unavailable' && <span className="badge danger">Unavailable</span>}
                    {m.status === 'limited' && <span className="badge warn">Rate-limited</span>}
                  </span>
                  {m.blocked && !off && <span className="tiny muted" style={{ display: 'block' }}>Not used: {m.blocked}</span>}
                  {m.last_error && m.status !== 'ok' && <span className="tiny warn-text" style={{ display: 'block' }}>{m.last_error === 'gone' ? 'No longer offered by the service.' : m.last_error}</span>}
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <button className="btn ghost sm" disabled={!!busy} onClick={() => test(m)}>{busy === m.ref ? 'Testing…' : m.tested_at ? 'Test again' : 'Test'}</button>
                  {m.paid !== false && <button className="btn ghost sm" onClick={() => setPricing({ ref: m.ref, input: m.price_in ?? '', output: m.price_out ?? '' })}>Price</button>}
                  <Switch label={`Use ${m.model}`} checked={!off} onChange={(v) => saveAi({ disabledModels: v ? settings.disabledModels.filter((x: string) => x !== m.ref) : [...settings.disabledModels, m.ref] })} />
                </span>
                {pricing?.ref === m.ref && (
                  <div className="row wrap price-edit" style={{ gap: 8, width: '100%', alignItems: 'flex-end' }}>
                    <div className="field"><label htmlFor="p-in">Input, USD per million tokens</label><input id="p-in" className="input" inputMode="decimal" style={{ width: 120 }} value={pricing!.input} onChange={(e) => setPricing({ ...pricing!, input: e.target.value })} /></div>
                    <div className="field"><label htmlFor="p-out">Output</label><input id="p-out" className="input" inputMode="decimal" style={{ width: 120 }} value={pricing!.output} onChange={(e) => setPricing({ ...pricing!, output: e.target.value })} /></div>
                    <button className="btn sm primary" onClick={savePrice}>Save price</button>
                    <button className="btn sm ghost" onClick={() => setPricing(null)}>Cancel</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {list.length > 30 && !showAll && <button className="linklike small" onClick={() => setShowAll(true)}>Show all {list.length} models</button>}
    </Section>
  );
}

// ---- Spending ------------------------------------------------------------------------------

function Spending({ settings, saveAi }: { settings: any; saveAi: (p: any) => void }) {
  const { data, reload } = useData<any>('/usage/summary');
  const [daily, setDaily] = useState<string>(settings.spend?.dailyUsd ?? '');
  const [monthly, setMonthly] = useState<string>(settings.spend?.monthlyUsd ?? '');
  const save = () => {
    const n = (v: string) => (String(v).trim() === '' ? null : Math.max(0, Number(v)));
    saveAi({ spend: { dailyUsd: n(daily), monthlyUsd: n(monthly) } });
    setTimeout(reload, 300);
  };
  const usd = (v: number) => `$${(v ?? 0).toFixed(v < 1 ? 4 : 2)}`;
  const bar = (spent: number, cap: number | null) => cap ? <div className="meter" role="meter" aria-valuenow={spent} aria-valuemax={cap} aria-label="Spent of limit"><span style={{ width: `${Math.min(100, (spent / cap) * 100)}%` }} className={spent >= cap ? 'over' : spent >= cap * 0.8 ? 'near' : ''} /></div> : null;
  return (
    <Section title="Spending" sub="What AI has cost, from what each service charges. At a limit, Carino stops using paid models; free and local ones carry on. You’re warned at 80%.">
      {!data ? <Loading rows={2} /> : (
        <div className="stack">
          <div className="spend-grid">
            <div><div className="tiny muted">Last 24 hours</div><div className="spend-num">{usd(data.today)}{data.limits.dailyUsd !== null && <span className="tiny muted"> of ${data.limits.dailyUsd}</span>}</div>{bar(data.today, data.limits.dailyUsd)}</div>
            <div><div className="tiny muted">Last 30 days</div><div className="spend-num">{usd(data.month)}{data.limits.monthlyUsd !== null && <span className="tiny muted"> of ${data.limits.monthlyUsd}</span>}</div>{bar(data.month, data.limits.monthlyUsd)}</div>
          </div>
          {(data.warning.today || data.warning.month) && <div className="callout warning small"><Icon name="alert" size={16} />{data.warning.today === 'reached' || data.warning.month === 'reached' ? 'A spending limit is reached: paid models are paused.' : 'You’ve used over 80% of a spending limit.'}</div>}
          <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
            <div className="field"><label htmlFor="lim-d">Daily limit (USD)</label><input id="lim-d" className="input" style={{ width: 120 }} inputMode="decimal" placeholder="No limit" value={daily} onChange={(e) => setDaily(e.target.value)} /></div>
            <div className="field"><label htmlFor="lim-m">Monthly limit (USD)</label><input id="lim-m" className="input" style={{ width: 120 }} inputMode="decimal" placeholder="No limit" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></div>
            <button className="btn sm" onClick={save}>Save limits</button>
          </div>
          {data.byModel.length > 0 && (
            <table className="usage-table">
              <thead><tr><th>Model</th><th>Uses</th><th>Tokens</th><th>Cost</th></tr></thead>
              <tbody>{data.byModel.map((r: any) => <tr key={r.conn_id + r.model}><td className="ellipsis">{r.model}</td><td>{r.calls}</td><td>{Number(r.input_tokens + r.output_tokens).toLocaleString()}</td><td>{usd(r.cost_usd)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </Section>
  );
}

// ---- Accounts and tools ----------------------------------------------------------------------

function Accounts({ data, reload }: { data: any; reload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const disconnect = async (a: any) => {
    if (!(await confirm({ title: `Disconnect ${a.provider_label} (${a.label})?`, body: 'Carino signs out, asks the provider to cancel its access where it can, and deletes the saved sign-in.', confirm: 'Disconnect' }))) return;
    try {
      const r = await del<any>(`/apps/accounts/${a.id}`);
      toast(r.revoked ? `Disconnected — ${a.provider_label} cancelled Carino’s access` : `Disconnected. To remove Carino’s access at ${a.provider_label} too, open its connected-apps page.`);
      if (!r.revoked && r.manage_url) window.open(r.manage_url, '_blank', 'noopener');
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <Section title="Accounts and connected tools" sub="Signed in once; Carino refreshes these by itself. If one needs you, it shows here.">
      {!data.accounts.length && !data.connectors.length ? <p className="small muted">None yet. <Link to="/apps">Connect an app</Link></p> : (
        <ul className="list divided">
          {data.accounts.map((a: any) => (
            <li key={a.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <span className="grow" style={{ minWidth: 0 }}><b>{a.provider_label}</b> <span className="small muted">{a.label}</span>
                {a.detail && a.status !== 'ok' && <span className="tiny warn-text" style={{ display: 'block' }}>{a.detail}</span>}</span>
              <StatusChip status={a.status} detail={a.detail} at={a.checked_at} />
              {a.status === 'needs_sign_in' && <Link className="btn sm primary" to="/apps">Sign in again</Link>}
              <button className="btn ghost sm" onClick={() => disconnect(a)}>Disconnect</button>
            </li>
          ))}
          {data.connectors.map((c: any) => (
            <li key={c.id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <span className="grow" style={{ minWidth: 0 }}><b>{c.name}</b> <span className="tiny muted">{c.enabled ? 'Connected tool' : 'Switched off'}</span>
                {c.detail && c.status !== 'ok' && <span className="tiny warn-text" style={{ display: 'block' }}>{c.detail}</span>}</span>
              <StatusChip status={c.status} detail={c.detail} at={c.checked_at} />
              <Link className="btn ghost sm" to="/connectors">Manage</Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
