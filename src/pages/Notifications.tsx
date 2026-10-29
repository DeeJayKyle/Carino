import { useEffect } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, useConfirm } from '../components/ui';
import { useData } from '../lib/hooks';
import { del, post } from '../lib/api';
import { navigate } from '../lib/router';
import { relative } from '../lib/format';
import { useSession } from '../lib/session';

const ICON: Record<string, string> = { reminder: 'bell', action_failed: 'alert', routine: 'sparkle', info: 'info' };

export default function Notifications() {
  const { refreshCounts } = useSession();
  const { data, error, loading, reload } = useData<any>('/notifications');
  const confirm = useConfirm();
  useEffect(() => {
    if (data?.unread) {
      const t = setTimeout(() => post('/notifications/read', {}).then(refreshCounts), 1500);
      return () => clearTimeout(t);
    }
  }, [data?.unread, refreshCounts]);
  return (
    <Shell title="Notifications" actions={data?.notifications.length > 0 && (
      <button className="btn ghost sm" onClick={async () => {
        if (!(await confirm({ title: 'Clear all notifications?', body: 'This permanently deletes every notification in your inbox. Reminders and routines keep working.', confirm: 'Clear all', danger: true }))) return;
        await del('/notifications');
        reload();
        refreshCounts();
      }}><Icon name="trash" size={15} />Clear all</button>
    )}>
      <div className="page narrow">
        <ErrorBox error={error} retry={reload} />
        {loading && !data ? <Loading /> : data?.notifications.length === 0 ? (
          <Empty icon="bell" title="No notifications">Reminders, briefings and failed actions will appear here.</Empty>
        ) : (
          <div className="card"><ul className="list divided">
            {data?.notifications.map((n: any) => (
              <li key={n.id} className={`list-item ${n.link ? 'clickable' : ''}`} style={{ alignItems: 'flex-start' }} onClick={() => n.link && navigate(n.link)}>
                <Icon name={ICON[n.kind] ?? 'info'} style={{ color: n.kind === 'action_failed' ? 'var(--danger)' : 'var(--brand)', marginTop: 3 }} />
                <div className="grow">
                  <div style={{ fontWeight: n.read ? 500 : 700 }}>{n.title}</div>
                  {n.body && <div className="small muted">{n.body}</div>}
                  <div className="faint tiny">{relative(n.created_at)}</div>
                </div>
                {!n.read && <span className="badge accent">new</span>}
              </li>
            ))}
          </ul></div>
        )}
      </div>
    </Shell>
  );
}
