import { t } from '../lib/i18n';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { TaskItem } from '../components/TaskItem';
import { Empty, ErrorBox, Loading, Modal, StaleNote, Switch, useConfirm, useToast } from '../components/ui';
import { useData, useDebounced } from '../lib/hooks';
import { del, post, get, isOffline } from '../lib/api';
import { isQueued, isConflict, writeOrQueue } from '../lib/sync';
import { navigate, useLocation } from '../lib/router';
import { fmtDateTime, fromLocalInput, localDay, toLocalInput, getPrefs } from '../lib/format';
import { askPlacesPermission, placesPermission } from '../../mobile/native';

const VIEWS = [
  { id: 'today', label: 'Today' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'inbox', label: 'No date' },
  { id: 'all', label: 'All open' },
  { id: 'completed', label: 'Completed' },
  { id: 'calendar', label: 'Calendar' },
] as const;

export default function Tasks() {
  const { query } = useLocation();
  const [view, setView] = useState<string>(query.get('view') ?? 'today');
  const [q, setQ] = useState('');
  const [priority, setPriority] = useState('');
  const [sort, setSort] = useState('due');
  /** How many to show; grows by 500 with "Show more" (long lists stay quick to open). */
  const [limit, setLimit] = useState(500);
  const [editing, setEditing] = useState<any | null>(null);
  const dq = useDebounced(q);
  const apiView = view === 'calendar' ? 'all' : view === 'all' ? 'all' : view;
  const params = new URLSearchParams({ view: apiView, sort });
  if (dq) params.set('q', dq);
  if (priority) params.set('priority', priority);
  if (limit > 500) params.set('limit', String(limit));
  const { data, error, loading, stale, reload, setData } = useData<any>(`/tasks?${params}`, { cache: true });
  const load = useData<any>('/tasks/workload?days=7');
  const focus = query.get('focus');

  useEffect(() => {
    if (focus) get(`/tasks/${focus}`).then(setEditing).catch(() => undefined);
  }, [focus]);
  useEffect(() => {
    if (query.get('new')) document.getElementById('quick-add')?.focus();
  }, [query]);

  let tasks: any[] = data?.tasks ?? [];
  if (view === 'all') tasks = tasks.filter((t) => t.status === 'open');
  const topLevel = tasks.filter((t) => !t.parent_id || !tasks.some((p) => p.id === t.parent_id));

  const onChanged = (t: any) => {
    setData((d: any) => d && ({ ...d, tasks: d.tasks.map((x: any) => (x.id === t.id ? { ...x, ...t } : x)) }));
    setTimeout(reload, 600);
  };

  return (
    <Shell title={t('Tasks')}>
      <div className="page">
        <QuickAdd onCreated={reload} />
        <RemindersPanel />
        <div className="tabs" role="tablist" style={{ marginTop: 18 }}>
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
        <div className="task-filters">
          <input className="input" placeholder={t('Search tasks')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search tasks')} />
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)} aria-label={t('Filter by priority')}>
            <option value="">{t('Any priority')}</option><option value="1">{t('High')}</option><option value="2">{t('Normal')}</option><option value="3">{t('Low')}</option>
          </select>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={t('Sort')}>
            <option value="due">{t('Sort: due date')}</option><option value="priority">{t('Sort: priority')}</option><option value="created">{t('Sort: newest')}</option>
          </select>
        </div>
        <StaleNote savedAt={stale} />
        <WorkloadWarnings data={load.data} />
        <ErrorBox error={error} retry={reload} />
        {loading && !data ? <Loading rows={5} /> : view === 'calendar' ? (
          <CalendarView tasks={tasks} onOpen={setEditing} />
        ) : topLevel.length === 0 ? (
          <Empty icon="check" title={view === 'completed' ? 'No completed tasks yet' : view === 'overdue' ? 'Nothing overdue' : 'No tasks here'}>
            {view === 'today' ? 'Add one above — try “Call the supplier tomorrow at 10am”.' : 'Tasks you add will appear here.'}
          </Empty>
        ) : (
          <div className="card">
            <ul className="list" style={{ padding: 6 }}>
              {topLevel.map((t) => <TaskItem key={t.id} task={t} onChanged={onChanged} onOpen={(x) => get(`/tasks/${x.id}`).then(setEditing)} />)}
            </ul>
          </div>
        )}
        {data && view !== 'calendar' && (
          <div className="row wrap" style={{ marginTop: 10 }}>
            <p className="faint small grow">
              {(data.total ?? topLevel.length) > data.tasks.length
                ? `Showing ${data.tasks.length.toLocaleString()} of ${data.total.toLocaleString()} to-dos`
                : `${topLevel.length} to-do${topLevel.length === 1 ? '' : 's'}`}
            </p>
            {(data.total ?? 0) > data.tasks.length && <button className="btn sm" onClick={() => setLimit((n) => n + 500)}>{t('Show more')}</button>}
          </div>
        )}
      </div>
      {editing && <TaskEditor task={editing} onClose={() => { setEditing(null); if (focus) navigate('/tasks', { replace: true }); }} onSaved={() => reload()} />}
    </Shell>
  );
}

function QuickAdd({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      // Offline: date parsing needs the server, so save the text as a plain task to sync later.
      if (isOffline()) {
        await writeOrQueue('POST', '/tasks', { title: text.trim().slice(0, 300) }, { label: `New task “${text.trim().slice(0, 60)}”` });
        toast(t('Saved on this device — it will sync when you’re back online'));
        setText('');
        return;
      }
      const r = await post('/tasks/parse', { text });
      if (!r.needsConfirmation) {
        await post('/tasks', r.draft);
        toast(r.interpreted ? `Added for ${r.interpreted.local}` : 'Task added');
        setText('');
        onCreated();
      } else setDraft(r);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="quick-add" onSubmit={submit}>
        <label htmlFor="quick-add" className="sr-only">{t('Add a task')}</label>
        <input id="quick-add" className="input" placeholder={t('Add a task… e.g. “Remind me tomorrow morning to review the budget”')} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" disabled={busy || !text.trim()}><Icon name="plus" size={16} />{t('Add')}</button>
      </form>
      {draft && (
        <ConfirmDraft draft={draft} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); setText(''); onCreated(); }} />
      )}
    </>
  );
}

/** Shows how Carino interpreted a natural-language task so the user can confirm or adjust. */
function ConfirmDraft({ draft, onClose, onSaved }: { draft: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(draft.draft.title);
  const [due, setDue] = useState(toLocalInput(draft.draft.due_at));
  const [remind, setRemind] = useState(!!draft.draft.remind_at);
  const save = async () => {
    try {
      const dueIso = fromLocalInput(due);
      await post('/tasks', { title, due_at: dueIso, all_day: false, priority: draft.draft.priority, remind_at: remind && dueIso ? dueIso : null });
      toast(remind && dueIso ? `Reminder set for ${fmtDateTime(dueIso, { weekday: true })}` : 'Task added');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal title={t('Check the details')} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t('Cancel')}</button><button className="btn primary" onClick={save} disabled={!title.trim() || (remind && !due)}>{t('Save task')}</button></>}>
      <div className="stack">
        {draft.interpreted && <div className="callout brand small"><Icon name="info" size={16} />{t('I read “')}{draft.interpreted.text}{t('” as')}{' '}<strong>{draft.interpreted.local}</strong>.</div>}
        {draft.ambiguities.map((a: string) => <div key={a} className="callout warning small"><Icon name="alert" size={16} />{a}</div>)}
        <div className="field"><label htmlFor="d-title">{t('Task')}</label><input id="d-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="d-due">{t('Date & time (')}{getPrefs().timeZone})</label>
          <input id="d-due" className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <label className="checkbox"><input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />{t('Send me a reminder at this time')}</label>
      </div>
    </Modal>
  );
}

/** Concrete planning conflicts from /tasks/workload: overloaded days and tasks due before what they depend on. */
function WorkloadWarnings({ data }: { data: any }) {
  if (!data) return null;
  const over = data.days.filter((d: any) => d.overCapacity);
  const deps = data.dependencyConflicts;
  if (!over.length && !deps.length) return null;
  return (
    <div className="callout warning small" style={{ marginBottom: 12 }} role="status">
      <Icon name="info" size={16} />
      <div>
        {over.map((d: any) => <div key={d.date}>{fmtDateTime(`${d.date}T12:00:00Z`, { time: false, weekday: true })}{t(': about')}{' '}{Math.round(d.estimatedMinutes / 6) / 10} {t('h estimated across')}{' '}{d.tasks} task{d.tasks === 1 ? '' : 's'} {t('— more than')}{' '}{data.capacityMinutes / 60} h.</div>)}
        {deps.map((x: any) => <div key={x.task_id + x.depends_on_id}>“{x.task_title}{t('” is due before “')}{x.depends_on_title}{t('”, which it depends on.')}</div>)}
      </div>
    </div>
  );
}

export function TaskEditor({ task, onClose, onSaved }: { task: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [f, setF] = useState({
    title: task.title, description: task.description ?? '', priority: task.priority ?? 2, category: task.category ?? '',
    tags: (task.tags ?? []).join(', '), due: toLocalInput(task.due_at), all_day: !!task.all_day, estimate: task.estimate_minutes ?? '',
    recurrence: task.recurrence?.freq ?? '', interval: task.recurrence?.interval ?? 1,
  });
  const [remindAt, setRemindAt] = useState('');
  const [subtask, setSubtask] = useState('');
  const [subtasks, setSubtasks] = useState<any[]>(task.subtasks ?? []);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      const saved = await writeOrQueue('PATCH', `/tasks/${task.id}`, {
        title: f.title, description: f.description, priority: Number(f.priority), category: f.category,
        tags: f.tags.split(',').map((t: string) => t.trim()).filter(Boolean),
        due_at: fromLocalInput(f.due), all_day: f.all_day, estimate_minutes: f.estimate ? Number(f.estimate) : null,
        recurrence: f.recurrence ? { freq: f.recurrence, interval: Number(f.interval) || 1 } : null,
        ...(remindAt ? { remind_at: fromLocalInput(remindAt) } : {}),
      }, { label: `Edit to “${f.title}”`, entity: `tasks:${task.id}`, base: task.updated_at });
      toast(isQueued(saved) ? 'Saved on this device — it will sync when you’re back online'
        : isConflict(saved) ? 'This task was changed elsewhere since you opened it. Review it under “changes to check”.' : 'Task saved', isConflict(saved) ? 'error' : 'info');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addSub = async () => {
    if (!subtask.trim()) return;
    try {
      const s = await post('/tasks', { title: subtask, parent_id: task.id });
      setSubtasks((x) => [...x, s]);
      setSubtask('');
      onSaved();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: 'Delete this task?', body: `“${task.title}”${subtasks.length ? ` and its ${subtasks.length} subtask(s)` : ''} will be permanently deleted.`, confirm: 'Delete', danger: true }))) return;
    try {
      await del(`/tasks/${task.id}`);
      toast(t('Task deleted'));
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Modal wide title={t('Edit task')} onClose={onClose} footer={
      <>
        <button className="btn danger" onClick={remove}><Icon name="trash" size={15} />{t('Delete')}</button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>{t('Cancel')}</button>
        <button className="btn primary" onClick={save} disabled={busy || !f.title.trim()}>{t('Save')}</button>
      </>
    }>
      <div className="stack">
        <div className="field"><label htmlFor="t-title">{t('Title')}</label><input id="t-title" className="input" value={f.title} onChange={(e) => set('title', e.target.value)} /></div>
        <div className="field"><label htmlFor="t-desc">{t('Description')}</label><textarea id="t-desc" className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
        <div className="grid two">
          <div className="field"><label htmlFor="t-due">{t('Due (')}{getPrefs().timeZone})</label><input id="t-due" type="datetime-local" className="input" value={f.due} onChange={(e) => set('due', e.target.value)} /></div>
          <div className="field"><label htmlFor="t-prio">{t('Priority')}</label>
            <select id="t-prio" className="select" value={f.priority} onChange={(e) => set('priority', e.target.value)}><option value={1}>{t('High')}</option><option value={2}>{t('Normal')}</option><option value={3}>{t('Low')}</option></select>
          </div>
          <label className="checkbox"><input type="checkbox" checked={f.all_day} onChange={(e) => set('all_day', e.target.checked)} />{t('All-day')}</label>
          <div className="field"><label htmlFor="t-est">{t('Estimate (minutes)')}</label><input id="t-est" type="number" min={1} className="input" value={f.estimate} onChange={(e) => set('estimate', e.target.value)} /></div>
          <div className="field"><label htmlFor="t-cat">{t('Category')}</label><input id="t-cat" className="input" value={f.category} onChange={(e) => set('category', e.target.value)} /></div>
          <div className="field"><label htmlFor="t-tags">{t('Tags (comma separated)')}</label><input id="t-tags" className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} /></div>
          <div className="field"><label htmlFor="t-rec">{t('Repeats')}</label>
            <div className="row">
              <select id="t-rec" className="select" value={f.recurrence} onChange={(e) => set('recurrence', e.target.value)}>
                <option value="">{t('Does not repeat')}</option><option value="daily">{t('Daily')}</option><option value="weekly">{t('Weekly')}</option><option value="monthly">{t('Monthly')}</option><option value="yearly">{t('Yearly')}</option>
              </select>
              {f.recurrence && <input type="number" min={1} max={365} className="input" style={{ width: 90 }} value={f.interval} onChange={(e) => set('interval', e.target.value)} aria-label={t('Repeat every N')} />}
            </div>
            {f.recurrence && !f.due && <span className="hint">{t('Set a due date so the next occurrence can be scheduled.')}</span>}
          </div>
        </div>
        <div className="field">
          <label htmlFor="t-rem">{t('Add a reminder')}</label>
          <input id="t-rem" type="datetime-local" className="input" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} />
          {task.reminders?.filter((r: any) => r.status === 'scheduled').map((r: any) => (
            <span key={r.id} className="hint"><Icon name="bell" size={12} /> {t('Scheduled:')}{' '}{fmtDateTime(r.remind_at, { weekday: true })}</span>
          ))}
        </div>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>{t('Subtasks')}</div>
          <ul className="list">{subtasks.map((s) => <TaskItem key={s.id} task={s} showProject={false} onChanged={(t) => setSubtasks((x) => x.map((y) => (y.id === t.id ? { ...y, ...t } : y)))} />)}</ul>
          <div className="row" style={{ marginTop: 6 }}>
            <input className="input" placeholder={t('Add a subtask')} value={subtask} onChange={(e) => setSubtask(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void addSub())} aria-label={t('New subtask')} />
            <button className="btn" onClick={addSub}>{t('Add')}</button>
          </div>
        </div>
        <Dependencies task={task} />
        {task.history?.length > 0 && (
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>{t('History')}</summary>
            <ul className="small muted" style={{ paddingLeft: 18 }}>{task.history.map((h: any, i: number) => <li key={i}>{h.change} — {fmtDateTime(h.created_at)}</li>)}</ul>
          </details>
        )}
      </div>
    </Modal>
  );
}

function CalendarView({ tasks, onOpen }: { tasks: any[]; onOpen: (t: any) => void }) {
  const [offset, setOffset] = useState(0);
  const [includeDone, setIncludeDone] = useState(false);
  const base = new Date();
  const first = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday first
  const start = new Date(first);
  start.setDate(first.getDate() - startDow);
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = localDay(new Date());
  const byDay = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const t of tasks) {
      if (!t.due_at || (!includeDone && t.status === 'done')) continue;
      const k = localDay(t.due_at);
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return m;
  }, [tasks, includeDone]);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return (
    <div className="card pad">
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn icon sm" onClick={() => setOffset(offset - 1)} aria-label={t('Previous month')}><Icon name="chevronLeft" /></button>
        <h2 style={{ minWidth: 160, textAlign: 'center' }}>{first.toLocaleDateString(getPrefs().locale, { month: 'long', year: 'numeric' })}</h2>
        <button className="btn icon sm" onClick={() => setOffset(offset + 1)} aria-label={t('Next month')}><Icon name="chevronRight" /></button>
        <button className="btn sm" onClick={() => setOffset(0)}>{t('Today')}</button>
        <span className="spacer" />
        <label className="checkbox small"><Switch label={t('Show completed')} checked={includeDone} onChange={setIncludeDone} />{t('Completed')}</label>
      </div>
      <div className="cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="dow">{d}</div>)}
        {days.map((d) => {
          const k = key(d);
          const items = byDay.get(k) ?? [];
          return (
            <div key={k} className={`day ${d.getMonth() !== first.getMonth() ? 'other' : ''} ${k === today ? 'today' : ''}`}>
              <div className="n">{d.getDate()}</div>
              {items.slice(0, 3).map((t) => (
                <div key={t.id} className={`ev ${t.status === 'done' ? 'done' : ''}`} onClick={() => get(`/tasks/${t.id}`).then(onOpen)} title={t.title} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && get(`/tasks/${t.id}`).then(onOpen)}>{t.title}</div>
              ))}
              {items.length > 3 && <div className="faint">+{items.length - 3} more</div>}
            </div>
          );
        })}
      </div>
      <p className="faint tiny" style={{ marginTop: 10 }}>{t('Shows your Carino tasks only. To see them in Google/Outlook Calendar, enable the calendar feed in Settings.')}</p>
    </div>
  );
}

function Dependencies({ task }: { task: any }) {
  const [deps, setDeps] = useState<{ depends_on: any[]; blocks: any[] }>({ depends_on: task.depends_on ?? [], blocks: task.blocks ?? [] });
  const open = useData<any>('/tasks?view=all');
  const [pick, setPick] = useState('');
  const [err, setErr] = useState('');
  const candidates = (open.data?.tasks ?? []).filter((t: any) => t.status === 'open' && t.id !== task.id && !deps.depends_on.some((d) => d.id === t.id));
  const add = async () => {
    if (!pick) return;
    setErr('');
    try { setDeps(await post(`/tasks/${task.id}/dependencies`, { depends_on_id: pick })); setPick(''); } catch (e: any) { setErr(e?.message ?? 'Could not add'); }
  };
  return (
    <div>
      <div className="label" style={{ marginBottom: 6 }}>{t('Depends on')}</div>
      {deps.depends_on.map((d) => (
        <div key={d.id} className="row small" style={{ marginBottom: 4 }}>
          <span className={`badge ${d.status === 'done' ? 'success' : ''}`}>{d.status === 'done' ? 'done' : 'open'}</span>{d.title}
          <button className="btn sm ghost" aria-label={`Remove dependency on ${d.title}`} onClick={async () => setDeps(await del(`/tasks/${task.id}/dependencies/${d.id}`))}>{t('Remove')}</button>
        </div>
      ))}
      <div className="row">
        <select className="select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t('Add a dependency')}>
          <option value="">{t('Choose a task this depends on…')}</option>
          {candidates.map((t: any) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <button className="btn" onClick={add} disabled={!pick}>{t('Add')}</button>
      </div>
      {err && <span className="hint" role="alert">{err}</span>}
      {deps.blocks.length > 0 && <p className="hint">{t('Blocks:')}{' '}{deps.blocks.map((b) => b.title).join(', ')}</p>}
    </div>
  );
}

/** Short label for a reminder's repeat rule (stored as JSON), or '' when it rings once. */
function repeatText(json: string | null): string {
  if (!json) return '';
  try {
    const r = JSON.parse(json);
    if (r.freq === 'weekly' && r.byweekday?.length === 5) return 'Weekdays';
    return ({ daily: 'Every day', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' } as Record<string, string>)[r.freq] ?? 'Repeats';
  } catch {
    return 'Repeats';
  }
}

/** Upcoming timed reminders (with repeat, snooze and cancel) and place reminders. */
function RemindersPanel() {
  const toast = useToast();
  const timed = useData<any>('/reminders');
  const places = useData<any>('/place-reminders');
  const [perm, setPerm] = useState(() => placesPermission());
  const upcoming = (timed.data?.reminders ?? []).filter((r: any) => r.status === 'scheduled').slice(0, 20);
  const placeList = (places.data?.places ?? []).slice(0, 20);
  if (!upcoming.length && !placeList.length) return null;
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
    } catch (e: any) {
      toast(e?.message ?? 'That did not work', 'error');
    }
    void timed.reload();
    void places.reload();
  };
  const activePlaces = placeList.some((p: any) => p.status === 'active');
  return (
    <section className="card reminders-panel" aria-label={t('Reminders')}>
      <h2 className="row"><Icon name="bell" size={18} /> {t('Reminders')}</h2>
      {upcoming.map((r: any) => (
        <div key={r.id} className="reminder-row">
          <div className="grow">
            <div className="rem-title">{r.title}</div>
            <div className="tiny muted">{fmtDateTime(r.remind_at, { weekday: true })}{r.recurrence ? ` · ${repeatText(r.recurrence)}` : ''}</div>
          </div>
          <button className="btn ghost sm" onClick={() => act(() => post(`/reminders/${r.id}/snooze`, { minutes: 10 }), 'Snoozed for 10 minutes')} aria-label={`Snooze ${r.title} for 10 minutes`}>{t('Snooze')}</button>
          <button className="btn ghost sm" onClick={() => act(() => del(`/reminders/${r.id}`), 'Reminder cancelled')} aria-label={`Cancel ${r.title}`}><Icon name="x" size={16} /></button>
        </div>
      ))}
      {placeList.map((p: any) => (
        <div key={p.id} className={`reminder-row${p.status === 'fired' ? ' done' : ''}`}>
          <div className="grow">
            <div className="rem-title">📍 {p.title}</div>
            <div className="tiny muted">{p.status === 'fired' ? `Arrived ${fmtDateTime(p.fired_at)}` : `When you get to ${p.place_name}`}{p.address ? ` · ${p.address}` : ''}</div>
          </div>
          <button className="btn ghost sm" onClick={() => act(() => del(`/place-reminders/${p.id}`), p.status === 'fired' ? 'Removed' : 'Place reminder cancelled')} aria-label={`${p.status === 'fired' ? 'Remove' : 'Cancel'} ${p.title}`}><Icon name="x" size={16} /></button>
        </div>
      ))}
      {activePlaces && perm !== 'always' && perm !== 'web' && (
        <div className="callout">
          <span className="grow">{perm === 'no' ? 'Place reminders need your location.' : 'To ring while Carino is closed, allow location "All the time".'}</span>
          <button className="btn sm" onClick={async () => setPerm(await askPlacesPermission())}>{t('Allow location')}</button>
        </div>
      )}
    </section>
  );
}
