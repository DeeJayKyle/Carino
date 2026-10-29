import { useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/Avatar';
import { ErrorBox, Loading } from '../components/ui';
import { useData } from '../lib/hooks';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { useMascot } from '../lib/mascot';

/** What each card does when tapped. */
export function openCard(card: any) {
  if (card.action === 'chat') navigate(`/chat/new?q=${encodeURIComponent(card.prompt)}`);
  else if (card.action === 'routine') navigate(`/routines?idea=${encodeURIComponent(card.routine)}`);
  else if (card.action === 'ramble') navigate('/ramble');
  else if (card.action === 'voice') navigate('/chat/new?voice=1');
  else if (card.action === 'connect') navigate(card.id === 'group' ? '/messaging' : '/connectors');
}

const ACTION_LABEL: Record<string, string> = { chat: 'Start', routine: 'Set up', ramble: 'Talk it out', voice: 'Talk', connect: 'Connect' };

export default function Discover() {
  const { me } = useSession();
  const { data, error, loading, reload } = useData<any>('/discover');
  const [cat, setCat] = useState('For you');
  const name = me!.settings.profile.assistantName || 'Carino';
  const { accessory } = useMascot();
  const cards: any[] = data?.cards ?? [];
  const hasForYou = cards.some((c) => c.forYou);
  const cats = useMemo(() => [...(hasForYou ? ['For you'] : []), 'All', ...new Set(cards.map((c) => c.category))], [cards, hasForYou]);
  const active = cats.includes(cat) ? cat : cats[0];
  const shown = cards.filter((c) => active === 'All' || (active === 'For you' ? c.forYou : c.category === active));

  return (
    <Shell title="Discover">
      <div className="page">
        <div className="discover-hero">
          <Avatar size={84} accessory={accessory} />
          <div>
            <h1>What can {name} take off your plate?</h1>
            <p className="sub">Swipe through ideas and tap one to start. {name} asks for anything it needs, and nothing is sent, bought or deleted without your OK.</p>
          </div>
        </div>
        {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : (
          <>
            <div className="tabs" role="tablist" aria-label="Categories">
              {cats.map((c) => <button key={c} role="tab" aria-selected={active === c} className={active === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
            </div>
            <div className="discover-grid" role="list">
              {shown.map((c) => (
                <div key={c.id} role="listitem" className="li-wrap"><button className="card discover-card" onClick={() => openCard(c)}>
                  <span className="qi"><Icon name={c.icon} /></span>
                  <span className="tiny faint">{c.category}</span>
                  <span className="dc-title">{c.title}</span>
                  <span className="small muted grow">{c.blurb}</span>
                  <span className="dc-go">{ACTION_LABEL[c.action]} <Icon name="send" size={14} /></span>
                </button></div>
              ))}
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
