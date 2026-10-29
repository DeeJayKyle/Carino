import { useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, useToast } from '../components/ui';
import { post } from '../lib/api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { useDictation } from '../lib/voice';
import { fromLocalInput, toLocalInput } from '../lib/format';

type Item = {
  type: 'task' | 'reminder' | 'memory';
  title: string;
  details?: string;
  priority?: number;
  when_text?: string;
  when_iso?: string | null;
  when_label?: string;
  all_day?: boolean;
  warning?: string;
  keep: boolean;
};

const TYPE_ICON = { task: 'tasks', reminder: 'bell', memory: 'brain' } as const;
const TYPE_LABEL = { task: 'To-do', reminder: 'Reminder', memory: 'Memory' } as const;

export default function Ramble() {
  const toast = useToast();
  const { me } = useSession();
  const [text, setText] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<'sort' | 'add' | null>(null);
  const [done, setDone] = useState<{ tasks: number; reminders: number; memories: number } | null>(null);
  const voice = useDictation(me!.settings.voice.language, (t) => setText((x) => (x ? `${x} ${t}` : t)), { continuous: true });

  const sort = async () => {
    if (voice.listening) voice.stop();
    setBusy('sort');
    try {
      const r = await post<{ items: Omit<Item, 'keep'>[] }>('/ramble/extract', { text });
      setItems(r.items.map((i) => ({ ...i, keep: true })));
      setDone(null);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const kept = items!.filter((i) => i.keep);
    setBusy('add');
    try {
      const r = await post('/ramble/apply', { items: kept.map(({ keep, warning, when_text, when_label, ...rest }) => rest) });
      setDone(r);
      setItems(null);
      setText('');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const edit = (n: number, patch: Partial<Item>) => setItems((list) => list!.map((x, i) => (i === n ? { ...x, ...patch } : x)));
  const kept = items?.filter((i) => i.keep).length ?? 0;

  return (
    <Shell title="Ramble it out">
      <div className="page" style={{ maxWidth: 820 }}>
        <div className="page-head"><div>
          <h1>Ramble it out</h1>
          <p className="sub">Got a lot on your mind? Talk or type it all out, in any order. Carino sorts it into to-dos, reminders and things to remember, and you choose what to keep.</p>
        </div></div>

        {done && (
          <div className="callout small" style={{ marginBottom: 16 }}>
            <Icon name="check" size={16} />
            <span className="grow">Added {[done.tasks && `${done.tasks} task${done.tasks > 1 ? 's' : ''}`, done.reminders && `${done.reminders} reminder${done.reminders > 1 ? 's' : ''}`, done.memories && `${done.memories} memor${done.memories > 1 ? 'ies' : 'y'}`].filter(Boolean).join(', ')}.</span>
            <Link to="/tasks">Open tasks</Link>
          </div>
        )}

        {!items && (
          <section className="card pad stack">
            <label htmlFor="ramble" className="sr-only">Your ramble</label>
            <textarea id="ramble" className="textarea" rows={10} maxLength={20000} value={voice.interim ? `${text} ${voice.interim}` : text} onChange={(e) => setText(e.target.value)}
              placeholder="e.g. I need to order paracetamol by Friday, remind me to call Mama tomorrow at 5, the shop sign is broken, and I had an idea for a loyalty card…" />
            <div className="row wrap">
              {me!.settings.voice.enabled && voice.supported && (
                <button type="button" className={`btn ${voice.listening ? 'recording' : ''}`} onClick={voice.listening ? voice.stop : voice.start} aria-pressed={voice.listening}>
                  <Icon name={voice.listening ? 'stop' : 'mic'} size={16} />{voice.listening ? 'Stop talking' : 'Talk'}
                </button>
              )}
              <span className="grow small faint">{text.length > 0 && `${text.length.toLocaleString()} characters`}</span>
              <button className="btn primary" disabled={!text.trim() || busy === 'sort'} onClick={sort}><Icon name="sparkle" size={16} />{busy === 'sort' ? 'Sorting…' : 'Sort it out'}</button>
            </div>
            {voice.listening && <p className="faint tiny">Listening — take your time, pauses are fine. Speech is transcribed by your browser’s speech service.</p>}
            {voice.error && <p className="small" style={{ color: 'var(--danger)' }}>{voice.error}</p>}
          </section>
        )}

        {items && (
          <section className="stack">
            {items.length === 0 ? (
              <Empty icon="check" title="Nothing to add">Carino didn’t find any to-dos, reminders or things to remember in that. <button className="btn sm" onClick={() => setItems(null)}>Go back</button></Empty>
            ) : (
              <>
                <p className="small muted">Here’s what Carino picked out. Untick anything you don’t want, and check the dates before adding.</p>
                <ul className="list" style={{ gap: 10, display: 'grid' }}>
                  {items.map((i, n) => (
                    <li key={n} className={`card pad ramble-item ${i.keep ? '' : 'off'}`}>
                      <div className="row" style={{ alignItems: 'flex-start' }}>
                        <input type="checkbox" className="ramble-check" checked={i.keep} onChange={(e) => edit(n, { keep: e.target.checked })} aria-label={`Keep ${i.title}`} />
                        <div className="grow stack" style={{ gap: 6 }}>
                          <input className="input" value={i.title} maxLength={300} onChange={(e) => edit(n, { title: e.target.value })} aria-label="Title" />
                          {i.details && <p className="small muted">{i.details}</p>}
                          <div className="row wrap small">
                            <select className="input" style={{ width: 'auto' }} value={i.type} onChange={(e) => edit(n, { type: e.target.value as Item['type'] })} aria-label="Type">
                              {(['task', 'reminder', 'memory'] as const).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                            </select>
                            {i.type !== 'memory' && (
                              <input type="datetime-local" className="input" style={{ width: 'auto' }} aria-label="When"
                                value={i.when_iso ? toLocalInput(i.when_iso) : ''}
                                onChange={(e) => edit(n, { when_iso: e.target.value ? fromLocalInput(e.target.value) : null, all_day: false, warning: undefined })} />
                            )}
                            {i.type !== 'memory' && i.when_text && <span className="faint">from “{i.when_text}”</span>}
                            {i.priority === 1 && <span className="badge danger">urgent</span>}
                            <Icon name={TYPE_ICON[i.type]} size={14} style={{ color: 'var(--text-3)' }} />
                          </div>
                          {i.warning && i.type !== 'memory' && <p className="tiny warn-text">{i.warning}</p>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="row wrap">
              <button className="btn" onClick={() => setItems(null)}><Icon name="edit" size={16} />Back to my ramble</button>
              <span className="grow" />
              {items.length > 0 && <button className="btn primary" disabled={!kept || busy === 'add'} onClick={add}><Icon name="check" size={16} />{busy === 'add' ? 'Adding…' : `Add ${kept} item${kept === 1 ? '' : 's'}`}</button>}
            </div>
          </section>
        )}
      </div>
    </Shell>
  );
}
