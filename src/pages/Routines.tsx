import { useEffect, useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, Markdown, Modal, Switch, useConfirm, useToast } from '../components/ui';
import { useData } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { Link, useLocation } from '../lib/router';
import { fmtDateTime } from '../lib/format';

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];
const BUILT_IN_DESC: Record<string, string> = {
  morning_briefing: 'Your day: to-dos, anything overdue and today’s reminders.',
  evening_review: 'What you got done, what’s still open, and tomorrow’s priorities.',
};

export function scheduleText(days: number[], time: string) {
  const set = new Set(days);
  const when = set.size === 7 ? 'Every day'
    : set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d)) ? 'Weekdays'
    : set.size === 2 && set.has(0) && set.has(6) ? 'Weekends'
    : ORDER.filter((d) => set.has(d)).map((d) => DAY_NAMES[d]).join(', ');
  return `${when} at ${time}`;
}

type Draft = { id?: string; title: string; prompt: string; time_local: string; days: number[]; catalog_id?: string; needs?: string[]; steps?: string[]; access?: string[] | null };

export default function Routines() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useData<any>('/routines');
  const ideas = useData<any>('/routines/ideas');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [category, setCategory] = useState('All');
  const [running, setRunning] = useState<string | null>(null);
  const { query } = useLocation();
  const wanted = query.get('idea');
  useEffect(() => {
    const i = wanted && ideas.data?.ideas.find((x: any) => x.id === wanted);
    if (i) setDraft({ title: i.title, prompt: i.prompt, time_local: i.time, days: i.days, catalog_id: i.id, needs: i.needs });
  }, [wanted, ideas.data]);

  const list: any[] = data?.routines ?? [];
  const used = new Set(list.map((r) => r.catalog_id).filter(Boolean));
  const categories = useMemo(() => ['All', ...new Set<string>((ideas.data?.ideas ?? []).map((i: any) => i.category))], [ideas.data]);
  const shown = (ideas.data?.ideas ?? []).filter((i: any) => category === 'All' || i.category === category);

  const toggle = async (r: any, enabled: boolean) => {
    try {
      await patch(`/routines/${r.id}`, { enabled });
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const runNow = async (r: any) => {
    setRunning(r.id);
    try {
      await post(`/routines/${r.id}/run`);
      toast(`“${r.title}” ran — see the result below`);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setRunning(null);
      reload();
    }
  };
  const remove = async (r: any) => {
    if (!(await confirm({ title: `Delete “${r.title}”?`, body: 'It will stop running. Its chat history stays in Chat.', confirm: 'Delete', danger: true }))) return;
    try {
      await del(`/routines/${r.id}`);
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Shell title="Routines" actions={<button className="btn primary sm" onClick={() => setDraft({ title: '', prompt: '', time_local: '08:00', days: [1, 2, 3, 4, 5] })}><Icon name="plus" size={16} />New routine</button>}>
      <div className="page">
        <div className="page-head"><div>
          <h1>Routines</h1>
          <p className="sub">Things Carino does for you on a schedule — on the server, even when the app is closed. Results arrive as a notification and in the routine’s own chat. Anything that needs your approval waits for you.</p>
        </div></div>

        <section className="stack" style={{ marginBottom: 28 }}>
          <h2>Your routines</h2>
          {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : list.map((r) => (
            <div key={r.id} className="card pad">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{r.title}</div>
                  <div className="small muted">{scheduleText(r.days, r.time_local)}{r.custom ? '' : ' · built in'}</div>
                  <p className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.custom ? r.prompt : BUILT_IN_DESC[r.kind]}</p>
                  {r.custom && r.steps?.length > 0 && <ol className="small routine-steps">{r.steps.map((st: string, n: number) => <li key={n}>{st}</li>)}</ol>}
                  {r.custom && r.access_summary && <AccessSummary s={r.access_summary} />}
                </div>
                <Switch label={`Turn ${r.title} ${r.enabled ? 'off' : 'on'}`} checked={r.enabled} onChange={(v) => toggle(r, v)} />
              </div>
              {r.last_run_at && (
                <div className="small" style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <div className="faint">Last run {fmtDateTime(r.last_run_at)} · {r.last_status === 'failed' ? <span className="badge danger">failed</span> : <span className="badge">ok</span>}</div>
                  {r.last_status === 'failed' && r.last_error && <p className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>{r.last_error}</p>}
                  {r.last_status !== 'failed' && r.last_result && <div className="routine-result"><Markdown text={r.last_result} /></div>}
                </div>
              )}
              <div className="row wrap" style={{ marginTop: 10 }}>
                {r.custom && <button className="btn sm" disabled={running === r.id} onClick={() => runNow(r)}><Icon name="refresh" size={14} />{running === r.id ? 'Running…' : 'Run now'}</button>}
                <button className="btn ghost sm" onClick={() => setDraft({ id: r.id, title: r.title, prompt: r.prompt ?? '', time_local: r.time_local, days: r.days, steps: r.steps ?? [], access: r.access ?? null })}><Icon name="edit" size={14} />Edit</button>
                {r.conversation_id && <Link className="btn ghost sm" to={`/chat/${r.conversation_id}`}><Icon name="chat" size={14} />Open chat</Link>}
                {r.custom && <button className="btn ghost sm" onClick={() => remove(r)}><Icon name="trash" size={14} />Delete</button>}
              </div>
            </div>
          ))}
          {!loading && !error && !list.some((r) => r.custom) && (
            <Empty icon="sparkle" title="No routines of your own yet">Pick an idea below, or create one from scratch. You can also just ask Carino in chat: “every Friday at 4:30, log my wins”.</Empty>
          )}
        </section>

        <section>
          <div className="row wrap" style={{ marginBottom: 10 }}>
            <h2 className="grow">Ideas to get started</h2>
          </div>
          <div className="tabs" role="tablist" aria-label="Idea categories">
            {categories.map((c) => <button key={c} role="tab" aria-selected={category === c} className={category === c ? 'on' : ''} onClick={() => setCategory(c)}>{c}</button>)}
          </div>
          {ideas.loading ? <Loading /> : ideas.error ? <ErrorBox error={ideas.error} retry={ideas.reload} /> : (
            <div className="idea-strip" role="list">
              {shown.map((i: any) => (
                <article key={i.id} className="card pad idea" role="listitem">
                  <div className="row"><Icon name={i.icon} size={18} /><span className="tiny faint">{i.category}</span></div>
                  <h3 style={{ marginTop: 8 }}>{i.title}</h3>
                  <p className="small muted grow">{i.blurb}</p>
                  <div className="small faint">{scheduleText(i.days, i.time)}</div>
                  {i.needs?.includes('web_search') && <div className={`tiny ${ideas.data.webSearch ? 'faint' : 'warn-text'}`}>{ideas.data.webSearch ? 'Uses web search' : 'Needs web search set up on the server'}</div>}
                  {i.needs?.includes('connector') && <div className="tiny faint">Needs a <Link to="/connectors">connected app</Link></div>}
                  <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setDraft({ title: i.title, prompt: i.prompt, time_local: i.time, days: i.days, catalog_id: i.id, needs: i.needs })}>
                    {used.has(i.id) ? <><Icon name="check" size={14} />Added · add again</> : <><Icon name="plus" size={14} />Use this</>}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
      {draft && <RoutineEditor draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); reload(); }} builtIn={!!draft.id && !list.find((r) => r.id === draft.id)?.custom} />}
    </Shell>
  );
}

function RoutineEditor({ draft, onClose, onSaved, builtIn }: { draft: Draft; onClose: () => void; onSaved: () => void; builtIn: boolean }) {
  const toast = useToast();
  const [d, setD] = useState(draft);
  const [saving, setSaving] = useState(false);
  const blanks = d.prompt.match(/\[[^\]]+\]/g) ?? [];

  const save = async () => {
    setSaving(true);
    try {
      const steps = (d.steps ?? []).map((x) => x.trim()).filter(Boolean);
      const custom = { title: d.title, prompt: d.prompt, time_local: d.time_local, days: d.days, steps, access: d.access ?? null };
      if (d.id) await patch(`/routines/${d.id}`, builtIn ? { time_local: d.time_local, days: d.days } : custom);
      else await post('/routines', { ...custom, catalog_id: d.catalog_id });
      toast(d.id ? 'Routine saved' : `“${d.title}” added — it will run ${scheduleText(d.days, d.time_local).toLowerCase()}`);
      onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={d.id ? 'Edit routine' : 'New routine'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={saving || !d.days.length || (!builtIn && (!d.title.trim() || d.prompt.trim().length < 5 || blanks.length > 0))} onClick={save}>{saving ? 'Saving…' : d.id ? 'Save' : 'Add routine'}</button>
    </>}>
      <div className="stack">
        {!builtIn && (
          <>
            <div className="field"><label htmlFor="rt-title">Name</label><input id="rt-title" className="input" maxLength={80} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></div>
            <div className="field">
              <label htmlFor="rt-prompt">What should Carino do each time?</label>
              <textarea id="rt-prompt" className="textarea" rows={6} maxLength={2000} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} placeholder="e.g. Look at what I finished this week and save a short wins note." />
              {blanks.length > 0 && <div className="hint warn-text">Replace {blanks.map((b, n) => <span key={n}>{n > 0 && ', '}<code>{b}</code></span>)} with your own details.</div>}
              {d.needs?.includes('connector') && <div className="hint">This idea uses a <Link to="/connectors">connected app</Link> (e.g. your email or calendar). Without one, Carino will tell you it can’t reach it.</div>}
            </div>
            <StepsEditor steps={d.steps ?? []} onChange={(steps) => setD({ ...d, steps })} />
            <AccessEditor access={d.access ?? null} onChange={(access) => setD({ ...d, access })} />
          </>
        )}
        <div className="row wrap">
          <div className="field"><label htmlFor="rt-time">Time</label><input id="rt-time" type="time" className="input" style={{ width: 130 }} value={d.time_local} onChange={(e) => setD({ ...d, time_local: e.target.value })} /></div>
          <div className="field">
            <span className="label">Days</span>
            <div className="row" role="group" aria-label="Days">
              {ORDER.map((day) => {
                const on = d.days.includes(day);
                return <button key={day} type="button" className={`btn sm day-pick ${on ? 'primary' : ''}`} aria-pressed={on} aria-label={DAY_NAMES[day]} onClick={() => setD({ ...d, days: on ? d.days.filter((x) => x !== day) : [...d.days, day] })}>{DAY_LETTERS[day]}</button>;
              })}
            </div>
          </div>
        </div>
        <p className="small faint">Times are in your time zone (Settings → Regional). A routine missed by more than three hours — for example because the server was off — is skipped until its next day.</p>
      </div>
    </Modal>
  );
}

function StepsEditor({ steps, onChange }: { steps: string[]; onChange: (s: string[]) => void }) {
  const set = (n: number, v: string) => onChange(steps.map((x, i) => (i === n ? v : x)));
  const move = (n: number, by: number) => {
    const next = [...steps];
    const [x] = next.splice(n, 1);
    next.splice(n + by, 0, x);
    onChange(next);
  };
  return (
    <fieldset className="field">
      <legend className="label">Steps (optional)</legend>
      <p className="hint" style={{ marginTop: 0 }}>Break it into steps Carino follows in order, e.g. “Check bills due this week”, then “Add a to-do for each”.</p>
      {steps.map((st, n) => (
        <div key={n} className="row" style={{ gap: 6, marginTop: 6 }}>
          <span className="small faint" style={{ width: 18 }}>{n + 1}.</span>
          <input className="input grow" maxLength={400} value={st} aria-label={`Step ${n + 1}`} onChange={(e) => set(n, e.target.value)} />
          <button type="button" className="btn ghost sm" aria-label={`Move step ${n + 1} up`} disabled={n === 0} onClick={() => move(n, -1)}>↑</button>
          <button type="button" className="btn ghost sm" aria-label={`Remove step ${n + 1}`} onClick={() => onChange(steps.filter((_, i) => i !== n))}><Icon name="x" size={14} /></button>
        </div>
      ))}
      {steps.length < 12 && <button type="button" className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => onChange([...steps, ''])}><Icon name="plus" size={14} />Add a step</button>}
    </fieldset>
  );
}

type Group = { id: string; label: string; reads: string; does: string; asks: string };

function AccessEditor({ access, onChange }: { access: string[] | null; onChange: (a: string[] | null) => void }) {
  const { data } = useData<{ groups: Group[] }>('/routines/access');
  const groups = data?.groups ?? [];
  const limited = access !== null;
  return (
    <fieldset className="field">
      <legend className="label">What it can use</legend>
      <div className="row wrap" role="radiogroup" aria-label="What it can use" style={{ gap: 12 }}>
        <label className="row" style={{ gap: 6 }}><input type="radio" name="rt-access" checked={!limited} onChange={() => onChange(null)} />Everything Carino can use</label>
        <label className="row" style={{ gap: 6 }}><input type="radio" name="rt-access" checked={limited} onChange={() => onChange(access ?? [])} />Only what I pick</label>
      </div>
      {limited && (
        <ul className="access-pick">
          {groups.map((g) => (
            <li key={g.id}>
              <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={access!.includes(g.id)} onChange={(e) => onChange(e.target.checked ? [...access!, g.id] : access!.filter((x) => x !== g.id))} />
                <span><b>{g.label}</b><span className="tiny muted" style={{ display: 'block' }}>{[g.reads && `Reads ${g.reads}`, g.does && `Can ${g.does}`, g.asks && `Asks you before ${g.asks}`].filter(Boolean).join(' · ')}</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">It can always look at your to-dos, notes and saved knowledge. Sending, deleting, posting and other big actions always wait for your OK in Approvals.</p>
    </fieldset>
  );
}

function AccessSummary({ s }: { s: { everything: boolean; reads: string[]; does: string[]; asks: string[] } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tiny muted" style={{ marginTop: 6 }}>
      <button type="button" className="linklike tiny" aria-expanded={open} onClick={() => setOpen(!open)}>
        {s.everything ? 'Can use everything Carino can' : 'Limited to what you picked'} · {open ? 'hide' : 'details'}
      </button>
      {open && (
        <ul className="access-summary">
          <li><b>Reads:</b> {s.reads.join('; ')}</li>
          {s.does.length > 0 && <li><b>Can:</b> {s.does.join('; ')}</li>}
          {s.asks.length > 0 && <li><b>Asks you first before:</b> {s.asks.join('; ')}</li>}
        </ul>
      )}
    </div>
  );
}
