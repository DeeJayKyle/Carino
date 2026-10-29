import { useState, type FormEvent } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/Avatar';
import { useMascot } from '../lib/mascot';
import { ErrorBox, StaleNote } from '../components/ui';
import { useData } from '../lib/hooks';
import { useSession } from '../lib/session';
import { Link, navigate } from '../lib/router';
import { fmtDateTime, relative, getPrefs } from '../lib/format';
import { openCard } from './Discover';
import { useDictation } from '../lib/voice';

export function Home() {
  const { me } = useSession();
  const { data, error, stale, reload } = useData<any>('/dashboard', { cache: true });
  const discover = useData<any>('/discover');
  const mascot = useMascot();
  const name = me!.settings.profile.displayName || me!.user.name;

  const hour = data?.hour ?? new Date().getHours();
  const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const now = new Intl.DateTimeFormat(getPrefs().locale, { timeZone: getPrefs().timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const attention = (data?.notifications?.length ?? 0);

  return (
    <Shell title="Home">
      <div className="page">
        <div className="home-hero">
          <Link to="/chat/new?voice=1" className="home-mascot" aria-label={`Talk to ${mascot.name}`} title="Tap to talk hands-free"><Avatar size={112} accessory={mascot.accessory} /></Link>
          <div className="greet">{greet}, {name.split(' ')[0]}</div>
          <div className="date">{now}</div>
          <AskBar />
          <div className="starter-chips" role="list" aria-label="Quick starts">
            {[
              ['sun', 'My day', '/chat/new?q=' + encodeURIComponent('What does my day look like? Help me plan it.')],
              ['mic', 'Ramble it out', '/ramble'],
              ['bell', 'Remind me…', '/chat/new?q=' + encodeURIComponent('Remind me ')],
              ['speaker', 'Just talk', '/chat/new?voice=1'],
              ['phone', 'Help me call', '/chat/new?q=' + encodeURIComponent('Help me make a phone call: ')],
            ].map(([icon, label, to]) => <span key={label} role="listitem" className="li-wrap"><Link to={to} className="chip"><Icon name={icon} size={15} />{label}</Link></span>)}
          </div>
        </div>
        <StaleNote savedAt={stale} />
        <ErrorBox error={error} retry={reload} />
        {data && <HighlightCards data={data} idea={discover.data?.cards?.[0]} streakName={mascot.name} />}
        {attention > 0 && (
          <Link to="/notifications" className="card attention"><Icon name="bell" size={18} /><span className="grow">{attention} thing{attention > 1 ? 's' : ''} need{attention > 1 ? '' : 's'} your attention</span><Icon name="chevron" size={16} /></Link>
        )}
        {data?.recentConversations?.length > 0 && (
          <section className="home-section">
            <div className="row"><h2 className="grow">Recent chats</h2><Link to="/chat" className="small">All chats</Link></div>
            <div className="recent-chats">
              {data.recentConversations.slice(0, 6).map((c: any) => (
                <Link key={c.id} to={`/chat/${c.id}`} className="card recent-chat"><Icon name="chat" size={16} /><span className="grow ellipsis">{c.title}</span><span className="tiny faint">{relative(c.updated_at)}</span></Link>
              ))}
            </div>
          </section>
        )}
        {discover.data?.cards?.length > 1 && (
          <section className="home-section">
            <div className="row"><h2 className="grow">Ideas for you</h2><Link to="/discover" className="small">Discover</Link></div>
            <div className="idea-row">
              {discover.data.cards.slice(1, 7).map((c: any) => (
                <button key={c.id} className="card idea" onClick={() => openCard(c)}><span className="qi"><Icon name={c.icon} /></span><span className="idea-title">{c.title}</span></button>
              ))}
            </div>
          </section>
        )}
      </div>
    </Shell>
  );
}

function HighlightCards({ data, idea, streakName }: { data: any; idea?: any; streakName: string }) {
  const o = data.overview;
  const due = o.overdue.length + o.due.length;
  const next = o.reminders[0] ?? null;
  const nextTask = o.upcoming[0] ?? null;
  const cards: { key: string; tone: string; icon: string; kicker: string; title: string; body: string; to: string }[] = [
    {
      key: 'today', tone: o.overdue.length ? 'warn' : 'brand', icon: 'tasks', kicker: 'Today',
      title: due ? `${due} thing${due > 1 ? 's' : ''} to do` : 'Nothing due today',
      body: o.overdue.length ? `${o.overdue.length} overdue — tap to sort them out` : due ? [...o.overdue, ...o.due].slice(0, 2).map((t: any) => t.title).join(' · ') : 'Enjoy it, or plan something new.',
      to: '/tasks',
    },
    { key: 'brief', tone: 'sun', icon: 'sun', kicker: 'Your briefing', title: 'Here’s your day', body: data.briefing, to: '/chat/new?q=' + encodeURIComponent('What does my day look like? Help me plan it.') },
    {
      key: 'next', tone: 'sky', icon: next ? 'bell' : 'calendar', kicker: 'Coming up',
      title: next ? next.title : nextTask ? nextTask.title : 'A clear week ahead',
      body: next ? `Reminder · ${next.at}` : nextTask ? `Due ${fmtDateTime(nextTask.due_at, { weekday: true })}` : 'No deadlines or reminders in the next 7 days.',
      to: '/tasks?view=upcoming',
    },
  ];
  if (data.week) {
    cards.push({
      key: 'week', tone: 'leaf', icon: 'chart', kicker: 'Your week',
      title: `${data.week.tasksCompleted} done this week`,
      body: data.streak > 1 ? `🔥 ${data.streak} weeks in a row with ${streakName}${data.streak >= 4 ? ' — legendary 👑' : ''}` : `${data.week.tasksAdded} added · ${data.week.remindersSent} reminders sent`,
      to: '/me',
    });
  }
  if (idea) cards.push({ key: 'idea', tone: 'berry', icon: idea.icon, kicker: 'Try this', title: idea.title, body: idea.blurb, to: '/discover' });
  return (
    <section className="highlights" aria-label="Your day at a glance">
      {cards.map((c) => (
        <Link key={c.key} to={c.to} className={`highlight hl-${c.tone}`}>
          <span className="hl-kicker"><Icon name={c.icon} size={14} />{c.kicker}</span>
          <span className="hl-title">{c.title}</span>
          <span className="hl-body">{c.body}</span>
        </Link>
      ))}
    </section>
  );
}

function AskBar() {
  const [q, setQ] = useState('');
  const { me } = useSession();
  const voice = useDictation(me!.settings.voice.language, (t) => setQ((x) => (x ? `${x} ${t}` : t)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(`/chat/new?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    <>
      <form className="ask" onSubmit={submit} role="search">
        <Icon name="sparkle" style={{ color: 'var(--brand)' }} />
        <label htmlFor="ask" className="sr-only">Ask {me!.settings.profile.assistantName || 'Carino'}</label>
        <input id="ask" data-composer enterKeyHint="send" placeholder={voice.listening ? 'Listening…' : 'What’s on your mind?'} value={voice.interim ? `${q} ${voice.interim}` : q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        {me!.settings.voice.enabled && voice.supported && (
          <button type="button" className={`btn ghost icon ${voice.listening ? 'recording' : ''}`} onClick={voice.listening ? voice.stop : voice.start} aria-label={voice.listening ? 'Stop recording' : 'Speak'} aria-pressed={voice.listening}>
            <Icon name={voice.listening ? 'stop' : 'mic'} />
          </button>
        )}
        {q.trim() || !voice.supported
          ? <button className="btn primary icon" disabled={!q.trim()} aria-label="Ask"><Icon name="send" /></button>
          : <Link to="/chat/new?voice=1" className="btn primary icon" aria-label="Talk hands-free" title="Talk hands-free"><Icon name="speaker" /></Link>}
      </form>
      {voice.listening && <p className="faint tiny" style={{ marginTop: 6 }}>Recording… speech is transcribed by your browser’s speech service.</p>}
      {voice.error && <p className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{voice.error}</p>}
    </>
  );
}
