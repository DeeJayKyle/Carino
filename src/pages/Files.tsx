import { useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, Switch, fmtBytes, useConfirm, useToast } from '../components/ui';
import { useData, useDebounced } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { Link } from '../lib/router';
import { fmtDateTime } from '../lib/format';
import { canPickFolders, forgetFolder, pickFolder } from '../../mobile/native';

/**
 * Folders on this device the user chose to let Carino read: search inside them, find duplicates,
 * and see tidy-up ideas. Changes are optional per folder, always previewed and approved, and undoable.
 */
export default function Files() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useData<any>('/files');
  const [tab, setTab] = useState<'search' | 'duplicates' | 'tidy' | 'history'>('search');
  const [busy, setBusy] = useState('');
  const run = async (key: string, fn: () => Promise<any>, ok?: (r: any) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast(ok(r));
      reload();
      return r;
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const add = async () => {
    const picked = await pickFolder();
    if (!picked) return;
    await run('add', () => post('/files/folders', picked), (r) => `Added ${picked.label}: ${r.scan.files} file${r.scan.files === 1 ? '' : 's'}`);
  };
  const folders: any[] = data?.folders ?? [];
  return (
    <Shell title="Files">
      <div className="page">
        <div className="page-head"><div>
          <h1>Files</h1>
          <p className="sub">Folders on this device you choose to let Carino read: it can search inside your documents, spreadsheets and PDFs, find duplicates and suggest tidying up. Your files stay where they are; Carino only reads them.</p>
        </div></div>
        <ErrorBox error={error} retry={reload} />
        {loading && !data ? <Loading /> : data && !data.available ? (
          <Empty icon="folder" title="Not on this device">Folders can be shared from Carino for Windows and the Android app.</Empty>
        ) : data && (
          <>
            <section className="card pad" aria-label="Folders">
              <div className="row"><h2 className="grow">Folders Carino may read</h2>
                {canPickFolders() && <button className="btn primary sm" disabled={!!busy} onClick={add}><Icon name="plus" size={14} />{busy === 'add' ? 'Reading…' : 'Add a folder'}</button>}
              </div>
              {!folders.length ? <p className="small muted">None yet. Choose a folder in your phone’s or PC’s own folder picker; Carino can read only that folder and what’s inside it, and you can remove it any time.</p> : (
                <ul className="list divided">
                  {folders.map((f) => (
                    <li key={f.id} className="list-item" style={{ flexWrap: 'wrap' }}>
                      <Icon name="folder" size={16} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <b>{f.label}</b>
                        <span className="tiny muted" style={{ display: 'block' }}>{f.files} file{f.files === 1 ? '' : 's'}{f.last_scan_at ? ` · checked ${fmtDateTime(f.last_scan_at)}` : ''}{f.last_error ? <span className="warn-text"> · {f.last_error}</span> : ''}</span>
                      </span>
                      <Switch label={`Allow changes to ${f.label} (each one asks first)`} checked={f.can_change} onChange={(v) => run('perm', () => patch(`/files/folders/${f.id}`, { can_change: v }), () => (v ? 'Changes allowed — each one still asks you first' : 'Read only'))} />
                      <span className="tiny muted">{f.can_change ? 'Can change, with your OK' : 'Read only'}</span>
                      <Switch label={`Keep ${f.label} on my devices only`} checked={!!f.local_only} onChange={(v) => run('lo', () => patch(`/files/folders/${f.id}`, { local_only: v }), () => (v ? 'Only AI on your devices may read this folder' : 'Online AI may read files you ask about'))} />
                      <span className="tiny muted">{f.local_only ? 'Local AI only' : 'Any AI you use'}</span>
                      <button className="btn ghost sm" disabled={!!busy} onClick={() => run(`scan-${f.id}`, () => post(`/files/folders/${f.id}/scan`, {}), (r) => `${r.files} files, ${r.read} new or changed`)}><Icon name="refresh" size={14} />{busy === `scan-${f.id}` ? 'Checking…' : 'Check again'}</button>
                      <button className="btn ghost sm" aria-label={`Remove ${f.label}`} onClick={async () => {
                        if (!(await confirm({ title: `Remove ${f.label}?`, body: 'Carino stops reading it and forgets what it noted. Your files aren’t touched.', confirm: 'Remove' }))) return;
                        await run('rm', () => del(`/files/folders/${f.id}`), () => 'Removed');
                        forgetFolder(f.root);
                      }}><Icon name="x" size={14} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {folders.length > 0 && (
              <>
                <div className="tabs" role="tablist" aria-label="Files">
                  {([['search', 'Search'], ['duplicates', 'Duplicates'], ['tidy', 'Tidy up'], ['history', 'History']] as const).map(([id, l]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>)}
                </div>
                {tab === 'search' && <Search />}
                {tab === 'duplicates' && <Duplicates />}
                {tab === 'tidy' && <Tidy />}
                {tab === 'history' && <History />}
              </>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

function Search() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const { data } = useData<any>(dq.trim().length >= 2 ? `/files/search?q=${encodeURIComponent(dq.trim())}` : null);
  return (
    <section className="card pad" aria-label="Search files">
      <input className="input" placeholder="Search inside your files… e.g. “insurance” or “Paracetamol”" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search files" autoFocus />
      {data && (!data.results.length ? <p className="small muted" style={{ marginTop: 10 }}>Nothing found.</p> : (
        <ul className="list divided" style={{ marginTop: 8 }}>
          {data.results.map((f: any) => (
            <li key={f.id} className="list-item" style={{ alignItems: 'flex-start' }}>
              <Icon name="file" size={16} />
              <span className="grow" style={{ minWidth: 0 }}>
                <b className="ellipsis" style={{ display: 'block' }}>{f.name}</b>
                <span className="tiny muted" style={{ display: 'block' }}>{f.folder}/{f.rel_path} · {fmtBytes(f.size)}{f.where && f.where !== 'name' ? ` · ${f.where}` : ''}</span>
                {f.snippet && <span className="small" style={{ display: 'block' }}><Highlight text={f.snippet} /></span>}
              </span>
              <Link className="btn ghost sm" to={`/chat/new?q=${encodeURIComponent(`Summarise the file "${f.name}" from my folder ${f.folder} (file id ${f.id}).`)}`}>Summarise</Link>
            </li>
          ))}
        </ul>
      ))}
      <p className="tiny muted" style={{ marginTop: 8 }}>Searching happens on this device. “Summarise” sends that file’s text to your AI service to write the summary — except from folders kept on your devices, which only local AI reads.</p>
    </section>
  );
}

function Duplicates() {
  const { data } = useData<any>('/files/duplicates');
  if (!data) return <Loading />;
  if (!data.groups.length) return <Empty icon="check" title="No duplicates found" />;
  return (
    <section className="card pad" aria-label="Duplicates">
      <p className="small muted">The same content in more than one place. To remove extra copies, see Tidy up.</p>
      {data.groups.map((g: any) => (
        <div key={g.sha256} className="dup-group">
          <b>{g.copies} copies · {fmtBytes(g.size)} each</b>
          <ul className="tiny">{g.files.map((f: any, i: number) => <li key={f.id}>{f.folder}/{f.rel_path}{i === 0 ? ' — kept' : ''}</li>)}</ul>
        </div>
      ))}
    </section>
  );
}

function Tidy() {
  const toast = useToast();
  const { data, reload } = useData<any>('/files/suggestions');
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <Loading />;
  if (!data.suggestions.length) return <Empty icon="check" title="Nothing to tidy">Looks orderly. Ideas appear here when there are duplicates or loose files.</Empty>;
  const ask = async (s: any) => {
    try {
      const r = await post<any>('/files/changes', { ops: s.ops });
      toast(r.status === 'pending_approval' ? 'Waiting for your OK in Approvals' : 'Done');
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <section className="stack" aria-label="Tidy up">
      {data.suggestions.map((s: any) => (
        <div key={s.id} className="card pad">
          <b>{s.title}</b>
          <p className="small muted">{s.why}</p>
          <button className="linklike small" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Hide' : 'Preview'} the {s.ops.length} change{s.ops.length === 1 ? '' : 's'}</button>
          {open === s.id && <ul className="tiny">{s.ops.map((o: any, i: number) => <li key={i}>{o.op === 'move' ? `Move ${o.from} → ${o.to}` : `Delete ${o.path} (a copy is kept so it can be undone)`}</li>)}</ul>}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn sm primary" onClick={() => ask(s)}>Ask to do this</button>
            <Link className="btn ghost sm" to="/actions">Approvals</Link>
          </div>
        </div>
      ))}
      <p className="tiny muted">Nothing changes until you approve it in Approvals, and only in folders where you allowed changes.</p>
    </section>
  );
}

function History() {
  const toast = useToast();
  const { data, reload } = useData<any>('/files/history');
  if (!data) return <Loading />;
  if (!data.history.length) return <Empty icon="clock" title="No changes yet" />;
  return (
    <section className="card pad" aria-label="History">
      <ul className="list divided">
        {data.history.map((h: any) => (
          <li key={h.id} className="list-item">
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="ellipsis" style={{ display: 'block' }}>{h.op === 'move' ? `Moved ${h.from_rel} → ${h.to_rel}` : `Deleted ${h.from_rel}`}</span>
              <span className="tiny muted">{h.folder} · {fmtDateTime(h.created_at)}{h.status === 'undone' ? ' · undone' : ''}</span>
            </span>
            {h.status === 'done' && <button className="btn ghost sm" onClick={async () => { try { await post(`/files/history/${h.id}/undo`, {}); toast('Undone'); reload(); } catch (e: any) { toast(e.message, 'error'); } }}>Undo</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A search snippet with its matches ([like this]) highlighted. File text is untrusted: shown as text, never as HTML. */
function Highlight({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return <>{parts.map((p, i) => (p.startsWith('[') && p.endsWith(']') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}
