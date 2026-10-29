import { useState } from 'react';
import { Icon } from './Icon';
import { post } from '../lib/api';
import { useToast } from './ui';
import { useSession } from '../lib/session';

const RISK_LABEL: Record<string, string> = { read: 'Read-only', reversible: 'Reversible change', consequential: 'Needs your approval' };

/** Shows exactly what an action will do, with Approve / Decline. Nothing runs until approved. */
export function ApprovalCard({ action, onDecided }: { action: any; onDecided?: (a: any, outcome: any) => void }) {
  const toast = useToast();
  const { refreshCounts } = useSession();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [showInput, setShowInput] = useState(false);

  const decide = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    try {
      const out = await post(`/actions/${action.id}/${kind}`);
      if (kind === 'approve') {
        if (out.status === 'executed') toast(`Done: ${action.summary}`);
        else toast(`Failed: ${out.error}`, 'error');
      } else toast('Declined — nothing was changed.');
      onDecided?.(action, out);
      refreshCounts();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="approval" role="group" aria-label="Action awaiting approval">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Icon name="shield" size={18} style={{ color: 'var(--warning)', marginTop: 2, flex: 'none' }} />
        <div className="grow">
          <div style={{ fontWeight: 650 }}>{action.summary}</div>
          <div className="small muted">{RISK_LABEL[action.risk] ?? action.risk} · {action.tool.replace(/_/g, ' ')}{action.origin === 'routine' ? ' · from a routine' : ''}</div>
          {showInput && <pre className="mono tiny" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', background: 'var(--surface)', padding: 8, borderRadius: 8 }}>{JSON.stringify(action.input, null, 2)}</pre>}
        </div>
      </div>
      <div className="row wrap" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="btn ghost sm" onClick={() => setShowInput((s) => !s)}>{showInput ? 'Hide details' : 'Details'}</button>
        <button className="btn sm" disabled={!!busy} onClick={() => decide('reject')}>Decline</button>
        <button className={`btn sm ${action.risk === 'consequential' && action.tool.startsWith('delete') ? 'danger solid' : 'primary'}`} disabled={!!busy} onClick={() => decide('approve')}>
          {busy === 'approve' ? 'Working…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}
