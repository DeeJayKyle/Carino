import { t } from '../lib/i18n';
import { useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, Modal, useConfirm, useToast } from '../components/ui';
import { useData, useDebounced } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { Link, useLocation } from '../lib/router';
import { fmtDateTime } from '../lib/format';
import { useSession } from '../lib/session';

const CAT_LABEL: Record<string, string> = {
  profile: 'Profile', preference: 'Preferences', goal: 'Goals', routine: 'Routines', project: 'Plans', date: 'Important dates', fact: 'Facts', summary: 'Conversation summaries',
};

export default function Memory() {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = useSession();
  const { query } = useLocation();
  const [status, setStatus] = useState(query.get('status') ?? 'active');
  const [category, setCategory] = useState('');
  const [context, setContext] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const params = new URLSearchParams({ status, ...(category ? { category } : {}), ...(context ? { context } : {}), ...(dq ? { q: dq } : {}) });
  const { data, error, loading, reload } = useData<any>(`/memories?${params}`);
  const proposed = useData<any>('/memories?status=proposed');
  const [editing, setEditing] = useState<any | null>(null);
  const memOff = !me!.settings.memory.enabled;

  const exportMemories = () => {
    const blob = new Blob([JSON.stringify(data?.memories ?? [], null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `carino-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const togglePick = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const deletePicked = async () => {
    if (!(await confirm({ title: `Delete ${picked.size} ${picked.size === 1 ? 'memory' : 'memories'}?`, body: 'Carino will no longer know these things. This cannot be undone.', confirm: 'Delete', danger: true }))) return;
    try {
      const r = await post('/memories/delete', { ids: [...picked] });
      toast(`Deleted ${r.deleted}`);
      setPicked(new Set());
      reload();
      proposed.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const clearAll = async () => {
    const cats = category ? [category] : undefined;
    if (!(await confirm({ title: category ? `Delete all “${CAT_LABEL[category]}” memories?` : 'Delete ALL memories?', body: 'This permanently removes them. Carino will no longer know these things. This cannot be undone.', confirm: 'Delete permanently', danger: true }))) return;
    try {
      const r = await post('/memories/clear', { categories: cats, confirm: true });
      toast(`Deleted ${r.deleted} memories`);
      reload();
      proposed.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Shell title={t('Memory')} actions={<button className="btn primary sm" onClick={() => setEditing({})}><Icon name="plus" size={16} />{t('Add memory')}</button>}>
      <div className="page">
        <div className="page-head"><div><h1>{t('What Carino remembers')}</h1><p className="sub">{t('Long-term memory is separate from chat history. Only approved memories are used, and you can view, edit, export or delete any of them.')}</p></div></div>
        {memOff && <div className="callout warning" style={{ marginBottom: 14 }}><Icon name="info" size={16} />{t('Memory is turned off — Carino won’t use or save memories.')}{' '}<Link to="/settings#memory">{t('Turn it on in Settings')}</Link>.</div>}
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={status === 'active'} className={status === 'active' ? 'on' : ''} onClick={() => setStatus('active')}>{t('Saved')}</button>
          <button role="tab" aria-selected={status === 'proposed'} className={status === 'proposed' ? 'on' : ''} onClick={() => setStatus('proposed')}>
            {t('Waiting for approval')}{' '}{proposed.data?.memories.length > 0 && <span className="badge accent">{proposed.data.memories.length}</span>}
          </button>
        </div>
        <div className="row wrap" style={{ marginBottom: 14 }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder={t('Search memories')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search memories')} />
          <select className="select" style={{ maxWidth: 160 }} value={context} onChange={(e) => { setContext(e.target.value); setPicked(new Set()); }} aria-label={t('Personal or work')}>
            <option value="">{t('Personal and work')}</option><option value="personal">{t('Personal')}</option><option value="work">{t('Work')}</option>
          </select>
          <select className="select" style={{ maxWidth: 220 }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('Category')}>
            <option value="">{t('All categories')}</option>{Object.entries(CAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="spacer" />
          {picked.size > 0 && <button className="btn danger sm" onClick={deletePicked}><Icon name="trash" size={14} />{t('Delete')}{' '}{picked.size} selected</button>}
          <button className="btn sm" onClick={exportMemories} disabled={!data?.memories.length}><Icon name="download" size={14} />{t('Export')}</button>
          <button className="btn danger sm" onClick={clearAll} disabled={!data?.memories.length}><Icon name="trash" size={14} />{category ? 'Clear category' : 'Clear all'}</button>
        </div>
        {status === 'proposed' && <p className="small muted" style={{ marginBottom: 12 }}>{t('Carino suggested these but needs your OK — they may be sensitive, inferred rather than stated, or your settings require approval.')}</p>}
        <ErrorBox error={error} retry={reload} />
        {loading && !data ? <Loading /> : data?.memories.length === 0 ? (
          <Empty icon="brain" title={status === 'proposed' ? 'Nothing waiting for approval' : 'No memories yet'}>
            {status === 'proposed' ? '' : 'Tell Carino “remember that…” in chat, or add one here. Carino asks before saving anything sensitive.'}
          </Empty>
        ) : (
          <div className="card"><ul className="list divided">
            {data?.memories.map((m: any) => (
              <li key={m.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={picked.has(m.id)} onChange={() => togglePick(m.id)} aria-label={`Select “${m.content.slice(0, 40)}”`} style={{ marginTop: 4 }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div>{m.content}</div>
                  <div className="row wrap faint tiny" style={{ marginTop: 4 }}>
                    <span className="badge">{CAT_LABEL[m.category] ?? m.category}</span>
                    {m.context === 'work' && <span className="badge accent"><Icon name="briefcase" size={10} /> work</span>}
                    {!!m.local_only && <span className="badge success"><Icon name="lock" size={10} /> {t('on your devices only')}</span>}
                    {m.sensitive && <span className="badge warning"><Icon name="lock" size={10} /> sensitive{m.sensitivity ? ` · ${m.sensitivity}` : ''}</span>}
                    <span>{m.source === 'assistant' ? 'Suggested by Carino' : m.source === 'conversation_summary' ? 'From a conversation' : 'Added by you'} · {fmtDateTime(m.created_at, { time: false, year: true })}</span>
                    {m.last_used_at && <span>{t('· last used')}{' '}{fmtDateTime(m.last_used_at, { time: false })}</span>}
                    {m.expires_at && <span>{t('· expires')}{' '}{fmtDateTime(m.expires_at, { time: false })}</span>}
                    {m.source_ref && m.source === 'assistant' && <Link to={`/chat/${m.source_ref}`}>{t('· view conversation')}</Link>}
                  </div>
                </div>
                {m.status === 'proposed' && <button className="btn primary sm" onClick={async () => { await post(`/memories/${m.id}/approve`); toast(t('Memory saved')); reload(); proposed.reload(); }}>{t('Approve')}</button>}
                <button className="btn ghost icon sm" aria-label={t('Edit memory')} onClick={() => setEditing(m)}><Icon name="edit" size={15} /></button>
                <button className="btn ghost icon sm" aria-label={t('Delete memory')} onClick={async () => { await del(`/memories/${m.id}`); toast(m.status === 'proposed' ? 'Discarded' : 'Forgotten'); reload(); proposed.reload(); }}><Icon name="trash" size={15} /></button>
              </li>
            ))}
          </ul></div>
        )}
      </div>
      {editing && <MemoryForm memory={editing} onClose={() => setEditing(null)} onSaved={() => { reload(); proposed.reload(); }} />}
    </Shell>
  );
}

function MemoryForm({ memory, onClose, onSaved }: { memory: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [content, setContent] = useState(memory.content ?? '');
  const [category, setCategory] = useState(memory.category ?? 'fact');
  const [ctx, setCtx] = useState(memory.context ?? 'personal');
  const [expires, setExpires] = useState(memory.expires_at?.slice(0, 10) ?? '');
  const [localOnly, setLocalOnly] = useState(!!memory.local_only);
  const save = async () => {
    try {
      const body = { content, category, context: ctx, expires_at: expires ? new Date(`${expires}T23:59:00Z`).toISOString() : null };
      if (memory.id) await patch(`/memories/${memory.id}`, { ...body, local_only: localOnly });
      else {
        const made = await post<any>('/memories', body);
        const newId = made?.id ?? made?.memory?.id;
        if (localOnly && newId) await patch(`/memories/${newId}`, { local_only: true });
      }
      toast(t('Memory saved'));
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal title={memory.id ? 'Edit memory' : 'Add a memory'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>{t('Cancel')}</button><button className="btn primary" disabled={content.trim().length < 2} onClick={save}>{t('Save')}</button></>}>
      <div className="stack">
        <div className="field"><label htmlFor="m-c">{t('What should Carino remember?')}</label><textarea id="m-c" className="textarea" value={content} onChange={(e) => setContent(e.target.value)} placeholder={t('e.g. I prefer a morning briefing at 7:00 and short answers.')} /></div>
        <div className="grid two">
          <div className="field"><label htmlFor="m-cat">{t('Category')}</label><select id="m-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(CAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label htmlFor="m-ctx">{t('Part of')}</label><select id="m-ctx" className="select" value={ctx} onChange={(e) => setCtx(e.target.value)}><option value="personal">{t('Personal life')}</option><option value="work">{t('Work or business')}</option></select></div>
          <div className="field"><label htmlFor="m-exp">{t('Forget after (optional)')}</label><input id="m-exp" type="date" className="input" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
        </div>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />{t('Keep on my devices only — never shown to an online AI')}</label>
      </div>
    </Modal>
  );
}
