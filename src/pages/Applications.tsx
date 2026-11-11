import { useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, Modal, useConfirm, useToast } from '../components/ui';
import { useData } from '../lib/hooks';
import { del, patch, post, upload } from '../lib/api';
import { getPrefs } from '../lib/format';

const KIND_LABEL: Record<string, string> = { job: 'Job', scholarship: 'Scholarship', other: 'Other' };
const CLOSED = new Set(['accepted', 'rejected', 'withdrawn']);
const day = (d?: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(getPrefs().locale || undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const daysUntil = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86400_000);

/** Jobs and scholarships: deadlines, eligibility, documents, referees, progress and follow-ups. */
export default function Applications() {
  const [kind, setKind] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const { data, error, loading, reload } = useData<any>(`/applications${kind ? `?kind=${kind}` : ''}`);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list: any[] = (data?.applications ?? []).filter((a: any) => showClosed || !CLOSED.has(a.status));
  const statusLabel = (s: string) => data?.statuses.find((x: any) => x.id === s)?.label ?? s;

  return (
    <Shell title="Applications" actions={<button className="btn primary sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Add</button>}>
      <div className="page">
        <div className="page-head"><div>
          <h1>Applications</h1>
          <p className="sub">Jobs and scholarships you’re going for: deadlines, whether you qualify, the documents and referees each needs, and when to follow up. Or tell Carino: “track this job…” and paste the advert.</p>
        </div></div>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <div className="tabs" role="tablist" aria-label="Kind" style={{ margin: 0 }}>
            {[['', 'All'], ['job', 'Jobs'], ['scholarship', 'Scholarships']].map(([id, l]) => <button key={id} role="tab" aria-selected={kind === id} className={kind === id ? 'on' : ''} onClick={() => setKind(id)}>{l}</button>)}
          </div>
          <span className="spacer" />
          <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />Show finished</label>
        </div>
        <ErrorBox error={error} retry={reload} />
        {loading && !data ? <Loading /> : !list.length ? (
          <Empty icon="briefcase" title="Nothing tracked yet" action={<button className="btn primary" onClick={() => setAdding(true)}>Add one</button>}>Add a job or scholarship, and Carino reminds you before the deadline and to follow up after you apply.</Empty>
        ) : (
          <div className="card"><ul className="list divided">
            {list.map((a) => {
              const left = a.deadline ? daysUntil(a.deadline) : null;
              const urgent = left !== null && left <= 7 && left >= 0 && !CLOSED.has(a.status) && ['interested', 'preparing'].includes(a.status);
              return (
                <li key={a.id} className="list-item app-row">
                  <button className="app-open" onClick={() => setOpen(a.id)} aria-label={`Open ${a.title}`}>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="exp-title"><b>{a.title}</b>{a.organisation ? ` · ${a.organisation}` : ''}</span>
                      <span className="row wrap tiny muted" style={{ gap: 6, marginTop: 2 }}>
                        <span className="badge">{KIND_LABEL[a.kind]}</span>
                        <span className={`badge ${CLOSED.has(a.status) ? '' : 'accent'}`}>{statusLabel(a.status)}</span>
                        {a.deadline && <span className={urgent ? 'warn-text' : ''}>{left !== null && left < 0 ? 'Closed' : 'Closes'} {day(a.deadline)}{urgent ? ` · ${left === 0 ? 'today' : `${left} day${left === 1 ? '' : 's'} left`}` : ''}</span>}
                        {a.follow_up_on && !CLOSED.has(a.status) && <span>· follow up {day(a.follow_up_on)}</span>}
                        {a.eligible === 'no' && <span className="warn-text">· may not qualify</span>}
                      </span>
                      {a.progress.total > 0 && (
                        <span className="tiny muted">{a.progress.ready} of {a.progress.total} ready{a.progress.missing.length ? ` · still need ${a.progress.missing.slice(0, 3).join(', ')}${a.progress.missing.length > 3 ? '…' : ''}` : ''}</span>
                      )}
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                </li>
              );
            })}
          </ul></div>
        )}
      </div>
      {adding && <AddApplication onClose={() => setAdding(false)} onSaved={(id) => { setAdding(false); reload(); setOpen(id); }} />}
      {open && <ApplicationDetail id={open} statuses={data?.statuses ?? []} onClose={() => { setOpen(null); reload(); }} />}
    </Shell>
  );
}

function AddApplication({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ kind: 'job', title: '', organisation: '', deadline: '', url: '' });
  const save = async () => {
    try {
      const a = await post<any>('/applications', { kind: f.kind, title: f.title.trim(), organisation: f.organisation.trim() || undefined, deadline: f.deadline || undefined, url: f.url.trim() || undefined });
      toast(a.deadline_reminder_id ? 'Added — Carino reminds you 3 days before the deadline' : 'Added');
      onSaved(a.id);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal title="Track an application" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.title.trim()} onClick={save}>Add</button></>}>
      <div className="stack">
        <div className="field"><label htmlFor="a-kind">What</label>
          <select id="a-kind" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="job">Job</option><option value="scholarship">Scholarship</option><option value="other">Something else</option></select></div>
        <div className="field"><label htmlFor="a-title">{f.kind === 'scholarship' ? 'Scholarship' : 'Role'}</label><input id="a-title" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></div>
        <div className="field"><label htmlFor="a-org">Organisation</label><input id="a-org" className="input" value={f.organisation} onChange={(e) => setF({ ...f, organisation: e.target.value })} /></div>
        <div className="grid two">
          <div className="field"><label htmlFor="a-dl">Deadline</label><input id="a-dl" type="date" className="input" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></div>
          <div className="field"><label htmlFor="a-url">Link (optional)</label><input id="a-url" className="input" inputMode="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></div>
        </div>
      </div>
    </Modal>
  );
}

function ApplicationDetail({ id, statuses, onClose }: { id: string; statuses: { id: string; label: string }[]; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: a, reload } = useData<any>(`/applications/${id}`);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [newItem, setNewItem] = useState({ kind: 'document', label: '', contact: '' });
  if (!a) return <Modal title="Application" onClose={onClose}><Loading /></Modal>;
  const val = (k: string) => (k in draft ? draft[k] : a[k] ?? '');
  const set = (k: string, v: any) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async (patchBody: Record<string, any> = draft) => {
    if (!Object.keys(patchBody).length) return;
    try {
      await patch(`/applications/${id}`, patchBody);
      setDraft({});
      reload();
      toast('Saved');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const attach = (itemId: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void run(async () => { const r = await upload(file, { tags: 'application' }); await patch(`/application-items/${itemId}`, { document_id: r.document.id, status: 'ready' }); }, 'File attached');
    };
    input.click();
  };
  return (
    <Modal wide title={a.title} onClose={onClose} footer={<>
      <button className="btn ghost danger" onClick={async () => { if (await confirm({ title: 'Delete this application?', body: 'Its checklist, history and reminders go too. Attached files stay in Carino.', danger: true, confirm: 'Delete' })) { await del(`/applications/${id}`); onClose(); } }}><Icon name="trash" size={14} />Delete</button>
      <span className="spacer" />
      <button className="btn primary" disabled={!Object.keys(draft).length} onClick={() => save()}>Save changes</button>
    </>}>
      <div className="stack">
        <div className="grid two">
          <div className="field"><label htmlFor="d-status">Status</label>
            <select id="d-status" className="select" value={a.status} onChange={(e) => save({ status: e.target.value })}>{statuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            {a.status === 'applied' && a.follow_up_on && <span className="tiny muted">Carino reminds you to follow up on {day(a.follow_up_on)}.</span>}
          </div>
          <div className="field"><label htmlFor="d-dl">Deadline</label><input id="d-dl" type="date" className="input" value={val('deadline') ?? ''} onChange={(e) => set('deadline', e.target.value || null)} /></div>
          <div className="field"><label htmlFor="d-org">Organisation</label><input id="d-org" className="input" value={val('organisation')} onChange={(e) => set('organisation', e.target.value)} /></div>
          <div className="field"><label htmlFor="d-fu">Follow up on</label><input id="d-fu" type="date" className="input" value={val('follow_up_on') ?? ''} onChange={(e) => set('follow_up_on', e.target.value || null)} /></div>
        </div>
        <div className="field"><label htmlFor="d-elig">Eligibility — the requirements, and how you meet them</label>
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            {(['yes', 'unsure', 'no'] as const).map((e) => <button key={e} type="button" className={`chip${val('eligible') === e ? ' on' : ''}`} aria-pressed={val('eligible') === e} onClick={() => set('eligible', e)}>{e === 'yes' ? 'I qualify' : e === 'no' ? 'I don’t qualify' : 'Not sure'}</button>)}
          </div>
          <textarea id="d-elig" className="textarea" rows={3} value={val('eligibility')} onChange={(e) => set('eligibility', e.target.value)} />
        </div>
        <div className="grid two">
          <div className="field"><label htmlFor="d-next">Next step</label><input id="d-next" className="input" value={val('next_step')} onChange={(e) => set('next_step', e.target.value)} /></div>
          <div className="field"><label htmlFor="d-val">Salary or award</label><input id="d-val" className="input" value={val('value')} onChange={(e) => set('value', e.target.value)} /></div>
        </div>
        {a.url && <p className="small"><a href={a.url} target="_blank" rel="noopener noreferrer">Open the advert</a></p>}

        <section aria-label="Checklist">
          <h3 className="row">Checklist <span className="tiny muted">{a.progress.ready} of {a.progress.total} ready</span></h3>
          <ul className="list divided">
            {a.items.map((it: any) => (
              <li key={it.id} className="list-item">
                <input type="checkbox" checked={it.status === 'done' || it.status === 'ready'} onChange={(e) => run(() => patch(`/application-items/${it.id}`, { status: e.target.checked ? 'done' : 'needed' }))} aria-label={`${it.label} ready`} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span>{it.label}</span>
                  <span className="tiny muted" style={{ display: 'block' }}>{it.kind === 'referee' ? `Referee${it.contact ? ` · ${it.contact}` : ''}` : it.kind === 'document' ? 'Document' : 'Requirement'}{it.status === 'requested' ? ' · asked' : ''}
                    {it.document_id && <> · <Icon name="file" size={11} /> {it.document_name ?? 'file'}</>}</span>
                </span>
                {it.kind === 'referee' && it.status === 'needed' && <button className="btn ghost sm" onClick={() => run(() => patch(`/application-items/${it.id}`, { status: 'requested' }), 'Marked as asked')}>Asked</button>}
                {it.kind === 'document' && !it.document_id && <button className="btn ghost sm" onClick={() => attach(it.id)}><Icon name="paperclip" size={14} />Attach</button>}
                <button className="btn ghost sm" aria-label={`Remove ${it.label}`} onClick={() => run(() => del(`/application-items/${it.id}`))}><Icon name="x" size={14} /></button>
              </li>
            ))}
          </ul>
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            <select className="select" style={{ maxWidth: 140 }} value={newItem.kind} onChange={(e) => setNewItem({ ...newItem, kind: e.target.value })} aria-label="Kind of item">
              <option value="document">Document</option><option value="referee">Referee</option><option value="requirement">Requirement</option>
            </select>
            <input className="input grow" placeholder={newItem.kind === 'referee' ? 'Referee’s name' : newItem.kind === 'document' ? 'CV, transcript…' : 'e.g. Practising licence'} value={newItem.label} onChange={(e) => setNewItem({ ...newItem, label: e.target.value })} aria-label="Item" />
            {newItem.kind === 'referee' && <input className="input" style={{ maxWidth: 180 }} placeholder="Email or phone" value={newItem.contact} onChange={(e) => setNewItem({ ...newItem, contact: e.target.value })} aria-label="Referee contact" />}
            <button className="btn" disabled={!newItem.label.trim()} onClick={() => run(async () => { await post(`/applications/${id}/items`, { kind: newItem.kind, label: newItem.label.trim(), contact: newItem.contact.trim() || undefined }); setNewItem({ ...newItem, label: '', contact: '' }); })}><Icon name="plus" size={14} />Add</button>
          </div>
        </section>

        <div className="field"><label htmlFor="d-notes">Notes</label><textarea id="d-notes" className="textarea" rows={3} value={val('notes')} onChange={(e) => set('notes', e.target.value)} /></div>
        {a.events.length > 0 && (
          <details><summary className="small muted">History</summary>
            <ul className="list tiny" style={{ marginTop: 6 }}>{a.events.map((e: any, i: number) => <li key={i} className="muted">{day(String(e.created_at).slice(0, 10))} · {e.text}</li>)}</ul>
          </details>
        )}
      </div>
    </Modal>
  );
}
