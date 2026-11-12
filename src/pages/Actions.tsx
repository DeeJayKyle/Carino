import { t } from '../lib/i18n';
import { useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { ApprovalCard } from '../components/ApprovalCard';
import { Empty, ErrorBox, Loading } from '../components/ui';
import { useData } from '../lib/hooks';
import { Link } from '../lib/router';
import { fmtDateTime } from '../lib/format';

const STATUS_BADGE: Record<string, string> = { executed: 'success', failed: 'danger', rejected: '', cancelled: '', pending: 'accent', approved: 'brand' };

export default function Actions() {
  const [filter, setFilter] = useState('');
  const pending = useData<any>('/actions?status=pending');
  const history = useData<any>(`/actions?limit=200${filter ? `&status=${filter}` : ''}`);
  return (
    <Shell title={t('Approvals & activity')}>
      <div className="page narrow">
        <div className="page-head"><div><h1>{t('Approvals')}</h1><p className="sub">{t('Carino runs read-only and reversible actions within the permissions you set. Deletions and other consequential actions always wait here for you.')}</p></div></div>
        <ErrorBox error={pending.error} retry={pending.reload} />
        {pending.loading && !pending.data ? <Loading rows={2} /> : pending.data?.actions.length === 0 ? (
          <div className="card pad row"><Icon name="check" style={{ color: 'var(--success)' }} /><span>{t('Nothing waiting for approval.')}</span></div>
        ) : (
          <div className="stack">{pending.data?.actions.map((a: any) => <ApprovalCard key={a.id} action={a} onDecided={() => { pending.reload(); history.reload(); }} />)}</div>
        )}
        <div className="row" style={{ margin: '28px 0 10px' }}>
          <h2 className="grow">{t('Action history')}</h2>
          <select className="select" style={{ maxWidth: 170 }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('Filter history')}>
            <option value="">{t('All')}</option><option value="executed">{t('Completed')}</option><option value="failed">{t('Failed')}</option><option value="rejected">{t('Declined')}</option>
          </select>
          <Link to="/settings#permissions" className="btn sm"><Icon name="shield" size={14} />{t('Permissions')}</Link>
        </div>
        <ErrorBox error={history.error} retry={history.reload} />
        {history.loading && !history.data ? <Loading /> : history.data?.actions.length === 0 ? <Empty icon="clock" title={t('No actions yet')} /> : (
          <div className="card"><ul className="list divided">
            {history.data?.actions.filter((a: any) => a.status !== 'pending').map((a: any) => (
              <li key={a.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="small" style={{ fontWeight: 600 }}>{a.summary}</div>
                  <div className="faint tiny">
                    {a.tool.replace(/_/g, ' ')} · {a.risk} · {a.origin === 'assistant' ? 'by Carino' : a.origin === 'routine' ? 'routine' : 'by you'} · {fmtDateTime(a.created_at)}
                    {a.conversation_id && <> · <Link to={`/chat/${a.conversation_id}`}>{a.conversation_title ?? 'conversation'}</Link></>}
                  </div>
                  {a.error && <div className="tiny" style={{ color: 'var(--danger)' }}>{a.error}</div>}
                </div>
                <span className={`badge ${STATUS_BADGE[a.status] ?? ''}`}>{a.status === 'executed' ? 'done' : a.status === 'rejected' ? 'declined' : a.status}</span>
              </li>
            ))}
          </ul></div>
        )}
        <p className="faint tiny" style={{ marginTop: 10 }}>{t('History stores what each action did, not the full content you discussed.')}</p>
      </div>
    </Shell>
  );
}
