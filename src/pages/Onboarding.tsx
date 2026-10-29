import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/Avatar';
import { useToast } from '../components/ui';
import { patch, post } from '../lib/api';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { useData } from '../lib/hooks';
import { MOBILE } from '../lib/device';
import { DeviceAI } from '../components/DeviceAI';

const NAMES = ['Carino', 'Nia', 'Amara', 'Zuri', 'Kito', 'Sage', 'Nova', 'Juno', 'Ada', 'Leo', 'Imani', 'Tendo', 'Ayo', 'Mira', 'Kai', 'Wren'];
const INTERESTS: [string, string, string][] = [
  ['organise', 'Getting organised', 'tasks'], ['work', 'Work', 'briefcase'], ['business', 'My business', 'chart'], ['money', 'Money', 'chart'],
  ['health', 'Health', 'heart'], ['food', 'Food & meals', 'note'], ['family', 'Family & friends', 'sparkle'], ['learn', 'Learning', 'book'],
  ['travel', 'Travel', 'globe'], ['home', 'Home', 'home'], ['goals', 'Goals', 'target'], ['shopping', 'Shopping & prices', 'target'],
];
/** Starter routine ideas per interest (ids from the routine catalog). */
const STARTERS: Record<string, string> = {
  organise: 'overdue-sweep', work: 'work-wins', business: 'business-followups', money: 'money-checkin', health: 'water-walk',
  food: 'meal-plan', family: 'occasions', learn: 'daily-lesson', goals: 'week-ahead', home: 'week-ahead', travel: 'week-ahead', shopping: 'money-checkin',
};

/** First-run setup: names, what to help with, and a few starter routines. Everything can be changed later. */
export default function Onboarding() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const ideas = useData<any>('/routines/ideas');
  const builtIns = useData<any>('/routines');
  const [step, setStep] = useState(0);
  // The phone app's account starts as “Friend”; ask for a real name instead of suggesting it.
  const [you, setYou] = useState(() => { const n = me!.settings.profile.displayName || me!.user.name; return MOBILE && n === 'Friend' ? '' : n; });
  const [assistant, setAssistant] = useState(me!.settings.profile.assistantName || 'Carino');
  const [interests, setInterests] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set(['morning_briefing']));
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState(() => NAMES.slice(0, 6));

  const starterIdeas = useMemo(() => {
    const ids = [...new Set(interests.map((i) => STARTERS[i]).filter(Boolean))].slice(0, 4);
    return (ideas.data?.ideas ?? []).filter((i: any) => ids.includes(i.id) && !/\[[^\]]+\]/.test(i.prompt));
  }, [interests, ideas.data]);

  const finish = async (skip = false) => {
    setBusy(true);
    try {
      if (!skip) {
        for (const r of builtIns.data?.routines ?? []) {
          if (!r.custom && picked.has(r.kind) !== r.enabled) await patch(`/routines/${r.id}`, { enabled: picked.has(r.kind) });
        }
        for (const i of starterIdeas) {
          if (picked.has(i.id)) await post('/routines', { title: i.title, prompt: i.prompt, time_local: i.time, days: i.days, catalog_id: i.id });
        }
      }
      await patch('/settings', { onboarded: true, ...(skip ? {} : { profile: { displayName: you.trim(), assistantName: assistant.trim() || 'Carino', interests } }) });
      await refresh();
      navigate(skip ? '/' : '/discover', { replace: true });
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const steps = [
    <div key="you" className="stack">
      <h1>Hi! Let’s get you set up.</h1>
      <p className="muted">I’m your personal assistant. I remember what matters, keep your to-dos and reminders, and do the small stuff you’d rather not.</p>
      <div className="field"><label htmlFor="ob-you">What should I call you?</label><input id="ob-you" className="input" maxLength={80} value={you} onChange={(e) => setYou(e.target.value)} autoFocus /></div>
    </div>,
    <div key="me" className="stack">
      <h1>What will you call me?</h1>
      <p className="muted">Pick a name, or type your own. You can change it any time in Settings.</p>
      <input className="input" maxLength={40} value={assistant} onChange={(e) => setAssistant(e.target.value)} aria-label="Assistant name" />
      <div className="row wrap">
        {suggestions.map((n) => <button key={n} className={`btn sm ${assistant === n ? 'primary' : ''}`} onClick={() => setAssistant(n)}>{n}</button>)}
        <button className="btn ghost sm" onClick={() => setSuggestions([...NAMES].sort(() => Math.random() - 0.5).slice(0, 6))}><Icon name="refresh" size={14} />More names</button>
      </div>
    </div>,
    ...(MOBILE ? [
      <div key="ai" className="stack">
        <h1>Give {assistant.trim() || 'me'} a brain</h1>
        <p className="muted">I live on your phone, and I use an AI service to think. Groq and Google Gemini are free — pick one, get a key in a minute, and paste it here. You can do this later in Settings.</p>
        <DeviceAI compact onSaved={() => setStep((x) => x + 1)} />
      </div>,
    ] : []),
    <div key="help" className="stack">
      <h1>What would you like help with, {you.split(' ')[0] || 'friend'}?</h1>
      <p className="muted">Choose a few. I’ll suggest the right ideas first.</p>
      <div className="ob-chips">
        {INTERESTS.map(([id, label, icon]) => (
          <button key={id} className={`ob-chip ${interests.includes(id) ? 'on' : ''}`} aria-pressed={interests.includes(id)} onClick={() => setInterests(interests.includes(id) ? interests.filter((x) => x !== id) : [...interests, id])}>
            <Icon name={icon} size={16} />{label}
          </button>
        ))}
      </div>
    </div>,
    <div key="routines" className="stack">
      <h1>Let’s set up your first routines</h1>
      <p className="muted">Routines run on their own and send you a notification. Tick the ones you want — you can change or add more on the Routines page.</p>
      <ul className="list divided">
        {[{ id: 'morning_briefing', title: 'Morning briefing', blurb: 'Your day at 07:00: tasks, deadlines and reminders.' }, { id: 'evening_review', title: 'Evening review', blurb: 'At 19:00: what you finished and tomorrow’s priorities.' },
          ...starterIdeas.map((i: any) => ({ id: i.id, title: i.title, blurb: i.blurb }))].map((r) => (
          <li key={r.id} className="list-item">
            <input type="checkbox" className="ramble-check" style={{ marginTop: 0 }} checked={picked.has(r.id)} onChange={() => setPicked(toggle(picked, r.id))} aria-label={r.title} />
            <div className="grow"><div style={{ fontWeight: 600 }}>{r.title}</div><div className="small muted">{r.blurb}</div></div>
          </li>
        ))}
      </ul>
    </div>,
  ];

  return (
    <div className="onboarding">
      <div className="ob-card card pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Avatar size={64} state={step === steps.length - 1 ? 'speaking' : 'idle'} />
          <button className="btn ghost sm" disabled={busy} onClick={() => finish(true)}>Skip</button>
        </div>
        <div style={{ marginTop: 18 }}>{steps[step]}</div>
        <div className="row" style={{ marginTop: 22 }}>
          <div className="ob-dots grow" aria-label={`Step ${step + 1} of ${steps.length}`}>{steps.map((_, i) => <span key={i} className={i === step ? 'on' : ''} />)}</div>
          {step > 0 && <button className="btn" disabled={busy} onClick={() => setStep(step - 1)}>Back</button>}
          {step < steps.length - 1
            ? <button className="btn primary" disabled={(step === 0 && !you.trim()) || (step === 1 && !assistant.trim())} onClick={() => setStep(step + 1)}>Next</button>
            : <button className="btn primary" disabled={busy} onClick={() => finish()}>{busy ? 'Setting up…' : 'Let’s go'}</button>}
        </div>
      </div>
    </div>
  );
}
