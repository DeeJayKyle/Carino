import { useState } from 'react';
import { Icon } from './Icon';
import { Modal, useToast } from './ui';
import { post } from '../lib/api';
import { useData } from '../lib/hooks';
import { Link } from '../lib/router';

const pathFor = (h: any) => (h.kind === 'chat' ? `/chat/${h.ref_id}` : h.kind === 'task' ? `/tasks?focus=${h.ref_id}` : '/applications');

/** "Continue on my other device": shown only once a phone and PC are paired. */
export function HandoffButton({ kind, refId }: { kind: 'chat' | 'task' | 'application'; refId: string }) {
  const toast = useToast();
  const { data } = useData<any>('/sync', { cache: true });
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const peer = data?.peers?.find((p: any) => p.confirmed);
  if (!peer) return null;
  const send = async () => {
    try {
      await post('/handoffs', { kind, ref_id: refId, note: note.trim() });
      // On the phone, sync straight away so it's there when the user sits down at the PC.
      await post('/sync/now', {}).catch(() => undefined);
      toast(`Ready to continue on ${peer.name}`);
      setOpen(false);
      setNote('');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <>
      <button className="btn ghost sm" onClick={() => setOpen(true)} title={`Continue on ${peer.name}`}><Icon name="send" size={16} /><span className="desktop-only">Continue on {peer.name}</span></button>
      {open && (
        <Modal title={`Continue on ${peer.name}`} onClose={() => setOpen(false)} footer={<><button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary" onClick={send}>Send</button></>}>
          <div className="field"><label htmlFor="ho-note">A note for later (optional)</label><input id="ho-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Finish the cover letter" autoFocus /></div>
          <p className="tiny muted">It appears at the top of Home on {peer.name}, with this {kind === 'chat' ? 'chat' : kind === 'task' ? 'to-do' : 'application'} and its files.</p>
        </Modal>
      )}
    </>
  );
}

/** On Home: things started on the other device, to pick up here. */
export function HandoffBanner() {
  const { data, reload } = useData<any>('/handoffs');
  const items = (data?.handoffs ?? []).filter((h: any) => !h.from_here);
  if (!items.length) return null;
  return (
    <>
      {items.slice(0, 3).map((h: any) => (
        <div key={h.id} className="card pad handoff-banner">
          <Icon name="send" size={18} />
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="tiny muted" style={{ display: 'block' }}>From your other device</span>
            <b className="ellipsis" style={{ display: 'block' }}>{h.title}</b>
            {h.note && <span className="small">{h.note}</span>}
            {h.files.length > 0 && <span className="tiny muted" style={{ display: 'block' }}>{h.files.length} file{h.files.length === 1 ? '' : 's'} with it</span>}
          </span>
          <Link className="btn sm primary" to={pathFor(h)} onClick={() => void post(`/handoffs/${h.id}/done`, {}).then(reload, () => undefined)}>Continue</Link>
        </div>
      ))}
    </>
  );
}
