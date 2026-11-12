import { t } from '../lib/i18n';
import { useState } from 'react';
import { Icon } from './Icon';
import { ApiDownload } from './ApiFile';
import { Modal, useConfirm, useToast } from './ui';
import { api, del, post } from '../lib/api';
import { useData } from '../lib/hooks';
import { fmtBytes } from './ui';

const TABLE_LABEL: Record<string, string> = {
  tasks: 'To-dos', reminders: 'Reminders', memories: 'Memories', notes: 'Notes', documents: 'Files', conversations: 'Chats', messages: 'Messages',
  expenses: 'Spending', income: 'Income', bills: 'Bills', debts: 'Debts', savings_goals: 'Savings goals', budgets: 'Budgets', money_books: 'Money books',
  applications: 'Applications', routines: 'Routines', projects: 'Projects', settings: 'Settings', place_reminders: 'Place reminders',
};
const when = (name: string) => {
  const m = name.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : name;
};

/** Encrypted backups: make one (tested before it's offered), keep or download it, copy it to the cloud if wanted, and restore with a preview. */
export function BackupCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, reload } = useData<any>('/backup');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState('');
  const [restoring, setRestoring] = useState<{ name?: string; file?: File } | null>(null);
  const [cloudFor, setCloudFor] = useState<string | null>(null);

  const make = async () => {
    setBusy('make');
    try {
      const r = await post<any>('/backup', { passphrase: pass });
      toast(`Backup made and checked: ${r.records} records, ${r.files} file${r.files === 1 ? '' : 's'}. Keep your passphrase safe.`);
      setPass('');
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => { const f = input.files?.[0]; if (f) setRestoring({ file: f }); };
    input.click();
  };

  const backups: any[] = data?.backups ?? [];
  return (
    <div className="stack">
      <p className="small muted">{t('A backup is locked with a passphrase you choose; without it nobody — not even you — can open it. Each backup is checked by restoring it in a test before it’s kept. Sign-ins to your apps aren’t included: you sign in again after restoring.')}</p>
      <div className="row wrap" style={{ gap: 8 }}>
        <input className="input grow" type="password" autoComplete="new-password" placeholder={t('Passphrase (10+ characters)')} value={pass} onChange={(e) => setPass(e.target.value)} aria-label={t('Backup passphrase')} />
        <button className="btn primary" disabled={!!busy || pass.length < 10} onClick={make}><Icon name="lock" size={14} />{busy === 'make' ? 'Making and checking…' : 'Make a backup'}</button>
      </div>
      {backups.length > 0 && (
        <ul className="list divided">
          {backups.map((b) => (
            <li key={b.name} className="list-item backup-row">
              <span className="grow"><span>{b.kind === 'safety' ? 'Before restore · ' : ''}{when(b.name)}</span><span className="tiny muted" style={{ display: 'block' }}>{fmtBytes(b.size)} {t('· encrypted')}</span></span>
              <ApiDownload className="btn ghost sm" href={`/api/backup/files/${b.name}`} name={b.name}><Icon name="download" size={14} />{t('Save')}</ApiDownload>
              {(data?.cloud ?? []).length > 0 && <button className="btn ghost sm" onClick={() => setCloudFor(b.name)}><Icon name="upload" size={14} />{t('Cloud')}</button>}
              <button className="btn ghost sm" onClick={() => setRestoring({ name: b.name })}>{t('Restore')}</button>
              <button className="btn ghost sm" aria-label={t('Delete this backup')} onClick={async () => { if (await confirm({ title: 'Delete this backup?', danger: true, confirm: 'Delete' })) { await del(`/backup/files/${b.name}`); reload(); } }}><Icon name="trash" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn" onClick={pickFile}><Icon name="upload" size={14} />{t('Restore from a file…')}</button>
        {!(data?.cloud ?? []).length && <span className="tiny muted">{t('To keep a copy in Google Drive or OneDrive, connect it in My apps (optional).')}</span>}
      </div>
      {restoring && <RestoreDialog target={restoring} onClose={() => { setRestoring(null); reload(); }} />}
      {cloudFor && (
        <Modal title={t('Copy to the cloud')} onClose={() => setCloudFor(null)}>
          <p className="small muted">{t('The copy stays encrypted with your passphrase: Google or Microsoft can’t read it.')}</p>
          <div className="stack" style={{ marginTop: 10 }}>
            {(data?.cloud ?? []).map((a: any) => (
              <button key={a.id} className="btn" disabled={!!busy} onClick={async () => {
                setBusy('cloud');
                try {
                  const r = await post<any>('/backup/cloud', { name: cloudFor, account_id: a.id });
                  toast(`Saved to ${r.where}`);
                  setCloudFor(null);
                } catch (e: any) {
                  toast(e.message, 'error');
                } finally {
                  setBusy('');
                }
              }}>{a.provider === 'google' ? 'Google Drive' : 'OneDrive'} · {a.label}</button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function RestoreDialog({ target, onClose }: { target: { name?: string; file?: File }; onClose: () => void }) {
  const toast = useToast();
  const [pass, setPass] = useState('');
  const [preview, setPreview] = useState<any | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [busy, setBusy] = useState(false);
  const send = (path: string, extra: Record<string, any> = {}) => {
    if (target.name) return post<any>(path, { name: target.name, passphrase: pass, ...extra });
    const form = new FormData();
    form.set('file', target.file!);
    form.set('passphrase', pass);
    for (const [k, v] of Object.entries(extra)) form.set(k, String(v));
    return api<any>(path, { method: 'POST', form });
  };
  const open = async () => {
    setBusy(true);
    try {
      setPreview(await send('/backup/inspect'));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    setBusy(true);
    try {
      const r = await send('/backup/restore', { mode, confirm: true });
      toast(`Restored. A copy of what was here before was saved (“Before restore”), so you can undo it. ${r.note}`);
      onClose();
      setTimeout(() => location.reload(), 600);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const rows = (preview?.tables ?? []).filter((t: any) => t.in_backup || t.on_device);
  return (
    <Modal wide title={t('Restore a backup')} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>{t('Cancel')}</button>
      {!preview ? <button className="btn primary" disabled={busy || !pass} onClick={open}>{busy ? 'Opening…' : 'Open and preview'}</button>
        : <button className={`btn ${mode === 'replace' ? 'danger solid' : 'primary'}`} disabled={busy} onClick={restore}>{busy ? 'Restoring…' : mode === 'replace' ? 'Replace everything' : 'Add what’s missing'}</button>}
    </>}>
      {!preview ? (
        <div className="field">
          <label htmlFor="rp">{t('Passphrase for')}{' '}{target.name ?? target.file?.name}</label>
          <input id="rp" className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && pass) void open(); }} />
          <span className="tiny muted">{t('Opening it only checks and previews: nothing changes yet.')}</span>
        </div>
      ) : (
        <div className="stack">
          <p className="small">{t('Backup from')}{' '}<b>{new Date(preview.created_at).toLocaleString()}</b>{preview.from?.name ? ` (${preview.from.name})` : ''} {t('— opened and checked.')}</p>
          <div className="table-wrap"><table className="data-table small">
            <thead><tr><th>{t('What')}</th><th>{t('In backup')}</th><th>{t('Here now')}</th><th>{t('New')}</th><th>{t('Different')}</th></tr></thead>
            <tbody>{rows.map((t: any) => <tr key={t.table}><td>{TABLE_LABEL[t.table] ?? t.table.replace(/_/g, ' ')}</td><td>{t.in_backup}</td><td>{t.on_device}</td><td>{t.new}</td><td>{t.different}</td></tr>)}</tbody>
          </table></div>
          <div role="radiogroup" aria-label={t('How to restore')} className="stack" style={{ gap: 6 }}>
            <label className="row small" style={{ gap: 8, alignItems: 'flex-start' }}><input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} style={{ marginTop: 3 }} /><span><b>{t('Add what’s missing')}</b> {t('— keeps everything here; where a record differs, the one here is kept.')}</span></label>
            <label className="row small" style={{ gap: 8, alignItems: 'flex-start' }}><input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} style={{ marginTop: 3 }} /><span><b>{t('Replace everything')}</b> {t('— this account becomes exactly the backup. Anything added since is removed.')}</span></label>
          </div>
          <p className="tiny muted">{t('Before restoring, what’s here now is saved as an encrypted “Before restore” backup with the same passphrase, so you can undo it. Not in backups:')}{' '}{preview.left_out.join(', ').toLowerCase()}.</p>
        </div>
      )}
    </Modal>
  );
}
