import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading, useToast } from '../components/ui';
import { del } from '../lib/api';
import { useData } from '../lib/hooks';
import { Link } from '../lib/router';
import { fmtDateTime, money } from '../lib/format';
import { useMascot } from '../lib/mascot';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Your stuff": everything Carino is holding for you, with a way into each. */
export default function Stuff() {
  const { data: d, error, loading, reload } = useData<any>('/stuff', { cache: true });
  const { name } = useMascot();
  const mem = useData<any>('/memories?status=active');
  const toast = useToast();
  const weekAgo = Date.now() - 7 * 86400_000;
  const learned = (mem.data?.memories ?? []).filter((m: any) => Date.parse(m.created_at) >= weekAgo).slice(0, 5);
  const tiles = d ? [
    {
      to: '/tasks', icon: 'tasks', title: 'To-dos & reminders',
      main: plural(d.tasks.open, 'open to-do'),
      sub: [d.tasks.overdue && `${d.tasks.overdue} overdue`, d.tasks.dueToday && `${d.tasks.dueToday} due today`, d.reminders.upcoming && plural(d.reminders.upcoming, 'reminder') + ' this week'].filter(Boolean).join(' · ') || 'Nothing urgent',
      warn: d.tasks.overdue > 0,
    },
    {
      to: '/money', icon: 'wallet', title: 'Money',
      main: d.money?.spent ? `${money(d.money.spent, d.money.currency)} this month` : 'Nothing logged yet',
      sub: d.money?.over ? `${plural(d.money.over, 'budget')} over` : d.money?.budgets ? plural(d.money.budgets, 'budget') + ' set' : 'Spending and monthly budgets',
      warn: d.money?.over > 0,
    },
    { to: '/routines', icon: 'clock', title: 'Routines', main: plural(d.routines.active, 'routine') + ' on', sub: d.routines.custom ? plural(d.routines.custom, 'of your own', 'of your own') : 'Add your first one' },
    { to: '/memory', icon: 'brain', title: `What ${name} remembers`, main: plural(d.memories.active, 'memory', 'memories'), sub: d.memories.waiting ? `${d.memories.waiting} waiting for your OK` : 'You’re in control of all of it', warn: d.memories.waiting > 0 },
    { to: '/apps', icon: 'link', title: 'My apps', main: d.apps ? plural(d.apps, 'account') : 'None yet', sub: 'Gmail, Outlook, Drive, Instagram and more' },
    { to: '/messaging', icon: 'send', title: 'Messaging', main: d.chats ? plural(d.chats, 'linked chat') : 'Not set up', sub: 'Telegram and WhatsApp' },
  ] : [];

  return (
    <Shell title="Your stuff">
      <div className="page">
        <div className="page-head"><div>
          <h1>Your stuff</h1>
          <p className="sub">Everything {name} is holding for you — to-dos, reminders, money, routines, memories and the apps it can use.</p>
        </div></div>
        {d?.approvals > 0 && (
          <Link to="/actions" className="callout warning stuff-alert"><Icon name="shield" size={18} /><span className="grow"><b>{plural(d.approvals, 'action')}</b> waiting for your approval</span><Icon name="send" size={16} /></Link>
        )}
        {d?.reminders.next && (
          <p className="small muted" style={{ marginBottom: 14 }}><Icon name="bell" size={14} /> Next reminder: <b>{d.reminders.next.title}</b> · {fmtDateTime(d.reminders.next.remind_at)}</p>
        )}
        {loading && !d ? <Loading rows={4} /> : error && !d ? <ErrorBox error={error} retry={reload} /> : (
          <div className="stuff-grid">
            {tiles.map((t) => (
              <Link key={t.to} to={t.to} className="card stuff-tile">
                <span className="qi"><Icon name={t.icon} /></span>
                <span className="st-title">{t.title}</span>
                <span className="st-main">{t.main}</span>
                <span className={`small ${t.warn ? 'warn-text' : 'muted'}`}>{t.sub}</span>
              </Link>
            ))}
          </div>
        )}
        {learned.length > 0 && (
          <section className="card pad" style={{ marginTop: 16 }}>
            <div className="row"><h2 className="grow">New things {name} learned</h2><Link to="/memory" className="small">All memories</Link></div>
            <p className="small muted" style={{ marginBottom: 10 }}>From this week. Keep what’s right, forget what isn’t.</p>
            <ul className="list learned">
              {learned.map((m: any) => (
                <li key={m.id} className="list-item">
                  <Icon name="brain" size={16} /><span className="grow small">{m.content}</span>
                  <button className="btn ghost sm" onClick={async () => { await del(`/memories/${m.id}`).catch((e) => toast(e.message, 'error')); mem.reload(); }}>Forget</button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Shell>
  );
}
