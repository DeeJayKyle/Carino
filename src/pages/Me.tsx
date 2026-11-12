import { t } from '../lib/i18n';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Avatar, type Accessory } from '../components/Avatar';
import { useToast } from '../components/ui';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { useMascot } from '../lib/mascot';
import { shareSticker } from '../lib/stickers';

const ACCESSORIES: { id: Accessory | 'auto'; label: string }[] = [
  { id: 'auto', label: 'Automatic' },
  { id: 'none', label: 'Nothing' },
  { id: 'party', label: 'Party hat' },
  { id: 'crown', label: 'Crown' },
  { id: 'chef', label: 'Chef’s hat' },
  { id: 'cap', label: 'Graduation cap' },
  { id: 'headband', label: 'Sports headband' },
];

const Bar = ({ value, goal, label }: { value: number; goal: number; label: string }) => (
  <span className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={goal} aria-valuenow={value}><span style={{ width: `${Math.round((value / goal) * 100)}%` }} /></span>
);

/** "Me": you, Carino's look, challenges, and the way into settings and inboxes. */
export default function Me() {
  const { me, counts, saveSettings } = useSession();
  const toast = useToast();
  const { accessory, achievements: a, earned, name } = useMascot();
  const choice = me!.settings.profile.mascotAccessory ?? 'auto';
  const rewardFor = (acc: string) => a?.challenges?.find((c: any) => c.reward === acc);
  const links = [
    { to: '/notifications', icon: 'bell', label: 'Notifications', count: counts.unread },
    { to: '/actions', icon: 'shield', label: 'Waiting for your OK', count: counts.pendingActions },
    { to: '/messaging', icon: 'send', label: 'Chat on Telegram or WhatsApp' },
    { to: '/apps', icon: 'link', label: 'My apps' },
    { to: '/settings#profile', icon: 'user', label: `You & ${name}` },
    { to: '/settings', icon: 'settings', label: 'Settings' },
  ];
  return (
    <Shell title={t('Me')}>
      <div className="page narrow">
        <section className="card me-hero">
          <Avatar size={110} accessory={accessory} state={a?.legendary ? 'happy' : 'idle'} />
          <div className="grow">
            <h1>{me!.settings.profile.displayName || me!.user.name}</h1>
            {a && (
              <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
                <span className="badge">🔥 {a.streak} week{a.streak === 1 ? '' : 's'} {t('in a row')}</span>
                <span className="badge">✅ {a.tasksDone} {t('to-dos done')}</span>
                {a.legendary && <span className="badge brand">{t('👑 Legendary')}</span>}
              </div>
            )}
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => shareSticker(accessory, name).then((m) => m && toast(m), (e) => toast(e.message, 'error'))}>
              <Icon name="smile" size={15} />{t('Share a')}{' '}{name} sticker
            </button>
          </div>
        </section>

        {a?.weekly && (
          <section className="card pad" style={{ marginTop: 14 }}>
            <h2>{t('This week')}</h2>
            <ul className="list goals">
              {a.weekly.map((g: any) => (
                <li key={g.id} className={`list-item ${g.done ? 'done' : ''}`}>
                  <Icon name={g.done ? 'check' : 'target'} size={18} />
                  <span className="grow">{g.title}</span>
                  <span className="tiny faint">{g.progress}/{g.goal}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {a?.challenges && (
          <section className="card pad" style={{ marginTop: 14 }}>
            <h2>{t('Challenges')}</h2>
            <p className="small muted">{t('Each one earns')}{' '}{name} {t('something new to wear.')}</p>
            <ul className="list challenges">
              {a.challenges.map((c: any) => (
                <li key={c.id} className={`challenge ${c.done ? 'done' : ''}`}>
                  <Avatar size={44} accessory={c.reward} />
                  <div className="grow">
                    <div className="row"><b className="grow">{c.title}</b>{c.done ? <span className="badge success"><Icon name="trophy" size={12} />{t('Done')}</span> : <span className="tiny faint">{c.progress}/{c.goal}</span>}</div>
                    <div className="small muted">{c.blurb}</div>
                    {!c.done && <Bar value={c.progress} goal={c.goal} label={`${c.title} progress`} />}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card pad" style={{ marginTop: 14 }}>
          <h2>{t('Dress up')}{' '}{name}</h2>
          <div className="acc-picker" role="radiogroup" aria-label={t('Accessory')}>
            {ACCESSORIES.map((x) => {
              const ok = x.id === 'auto' || earned(x.id as Accessory);
              const ch = rewardFor(x.id);
              return (
                <button key={x.id} role="radio" aria-checked={choice === x.id} disabled={!ok} className={`acc-opt ${choice === x.id ? 'on' : ''}`}
                  title={ok ? x.label : `Earn it: ${ch?.title ?? ''}`}
                  onClick={() => saveSettings({ profile: { mascotAccessory: x.id } }).catch((e: any) => toast(e.message, 'error'))}>
                  <Avatar size={46} accessory={x.id === 'auto' ? accessory : (x.id as Accessory)} />
                  <span className="tiny">{x.label}</span>
                  {!ok && ch && <span className="tiny faint">🔒 {ch.title}</span>}
                </button>
              );
            })}
          </div>
        </section>

        <section className="card" style={{ marginTop: 14 }}>
          <ul className="list divided">
            {links.map((l) => (
              <li key={l.to}>
                <Link to={l.to} className="list-item clickable me-link">
                  <Icon name={l.icon} size={18} /><span className="grow">{l.label}</span>
                  {!!l.count && <span className="count">{l.count}</span>}
                  <Icon name="chevron" size={14} style={{ color: 'var(--text-3)' }} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Shell>
  );
}
