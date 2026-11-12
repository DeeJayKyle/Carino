import { t } from '../lib/i18n';
import { useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Empty, useConfirm, useToast } from '../components/ui';
import { del, post } from '../lib/api';
import { getPrefs, money, parseAmount } from '../lib/format';

type Act = (fn: () => Promise<any>, ok?: string) => Promise<void>;

const dateLabel = (day: string | null | undefined) =>
  day ? new Date(`${day}T12:00:00Z`).toLocaleDateString(getPrefs().locale || undefined, { day: 'numeric', month: 'short', year: day.slice(0, 4) === new Date().toISOString().slice(0, 4) ? undefined : 'numeric', timeZone: 'UTC' }) : '';

/** Income, recurring bills, debts and savings goals for the chosen book. */
export function MoneyMore({ tab, d, cur, withBook, act }: { tab: 'income' | 'bills' | 'debts' | 'savings'; d: any; cur: string; withBook: (b: any) => any; act: Act }) {
  if (tab === 'income') return <Income d={d} cur={cur} withBook={withBook} act={act} />;
  if (tab === 'bills') return <Bills d={d} cur={cur} withBook={withBook} act={act} />;
  if (tab === 'debts') return <Debts d={d} cur={cur} withBook={withBook} act={act} />;
  return <Savings d={d} cur={cur} withBook={withBook} act={act} />;
}

/** A small one-line form: fields, then a button; amounts accept "15k". */
function QuickForm({ label, fields, onSubmit }: { label: string; fields: { name: string; label: string; type?: string; placeholder?: string; options?: [string, string][]; required?: boolean; max?: string }[]; onSubmit: (v: Record<string, string>) => Promise<boolean | void> }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.options?.[0]?.[0] ?? ''])));
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await onSubmit(v);
    setBusy(false);
    if (ok !== false) setV(Object.fromEntries(fields.map((f) => [f.name, f.options?.[0]?.[0] ?? ''])));
  };
  return (
    <form className="card pad quick-form" onSubmit={submit} aria-label={label}>
      {fields.map((f) => (
        <div key={f.name} className="field">
          <label htmlFor={`qf-${f.name}`}>{f.label}</label>
          {f.options ? (
            <select id={`qf-${f.name}`} className="select" value={v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}>
              {f.options.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
            </select>
          ) : (
            <input id={`qf-${f.name}`} className="input" type={f.type ?? 'text'} inputMode={f.type === 'amount' ? 'decimal' : undefined} placeholder={f.placeholder} max={f.max} value={v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
          )}
        </div>
      ))}
      <button className="btn primary" disabled={busy || fields.some((f) => f.required && !v[f.name]?.trim())}><Icon name="plus" size={16} />{label}</button>
    </form>
  );
}

function useAmount() {
  const toast = useToast();
  return (s: string) => {
    const n = parseAmount(s);
    if (n === null) toast(t('Enter an amount, e.g. 15000 or 15k'), 'error');
    return n;
  };
}

function Income({ d, cur, withBook, act }: { d: any; cur: string; withBook: (b: any) => any; act: Act }) {
  const amountOf = useAmount();
  return (
    <>
      <section className="card pad money-summary" aria-label={t('This month')}>
        <div className="ms-main"><span className="tiny muted">{t('Came in this month')}</span><span className="ms-total">{money(d.income, cur)}</span>
          <span className="small muted">{t('Spent')}{' '}{money(d.total, cur)} · <b className={d.net < 0 ? 'warn-text' : ''}>{money(d.net, cur)} {d.net < 0 ? 'more out than in' : 'left over'}</b></span></div>
      </section>
      <QuickForm label={t('Add income')} fields={[
        { name: 'amount', label: `Amount (${cur})`, type: 'amount', placeholder: '200k', required: true },
        { name: 'source', label: 'From', placeholder: 'Salary, sales…' },
        { name: 'received_on', label: 'Day', type: 'date', max: d.today },
      ]} onSubmit={async (v) => {
        const amount = amountOf(v.amount);
        if (amount === null) return false;
        await act(() => post('/income', withBook({ amount, source: v.source || undefined, received_on: v.received_on || undefined })), 'Income recorded');
      }} />
      <section className="card pad" aria-label={t('Income this month')}>
        <h2>{t('This month')}</h2>
        {!d.income_list.length ? <Empty icon="wallet" title={t('Nothing recorded yet')}>{t('Add it above, or tell Carino: “got paid 1.2m salary”.')}</Empty> : d.income_list.map((i: any) => (
          <div key={i.id} className="exp-row">
            <span className="grow"><span className="exp-title">{i.source || i.note || 'Income'}</span><span className="tiny muted">{dateLabel(i.received_on)}</span></span>
            <b className="exp-amt">{money(i.amount, i.currency)}</b>
            <button className="btn ghost sm" aria-label={`Delete ${i.source || 'income'}`} onClick={() => act(() => del(`/income/${i.id}`), 'Deleted')}><Icon name="trash" size={15} /></button>
          </div>
        ))}
      </section>
    </>
  );
}

function Bills({ d, cur, withBook, act }: { d: any; cur: string; withBook: (b: any) => any; act: Act }) {
  const amountOf = useAmount();
  const confirm = useConfirm();
  return (
    <>
      <QuickForm label={t('Add bill')} fields={[
        { name: 'name', label: 'Bill', placeholder: 'Rent, school fees…', required: true },
        { name: 'amount', label: `Amount (${cur})`, type: 'amount', placeholder: '600k', required: true },
        { name: 'repeat', label: 'Repeats', options: [['monthly', 'Every month'], ['weekly', 'Every week'], ['yearly', 'Every year']] },
        { name: 'next_due', label: 'Next due', type: 'date', required: true },
      ]} onSubmit={async (v) => {
        const amount = amountOf(v.amount);
        if (amount === null) return false;
        await act(() => post('/bills', withBook({ name: v.name.trim(), amount, repeat: v.repeat, next_due: v.next_due })), 'Bill added — Carino reminds you on the due day');
      }} />
      <section className="card pad" aria-label={t('Bills')}>
        <h2>{t('Coming up')}</h2>
        {!d.bills.length ? <Empty icon="calendar" title={t('No bills yet')}>{t('Add rent, school fees or subscriptions and Carino reminds you when they’re due.')}</Empty> : d.bills.map((b: any) => {
          const late = b.next_due < d.today;
          return (
            <div key={b.id} className="exp-row">
              <span className="grow"><span className="exp-title">{b.name}</span>
                <span className={`tiny ${late ? 'warn-text' : 'muted'}`}>{late ? 'Overdue since' : 'Due'} {dateLabel(b.next_due)} · {b.repeat === 'monthly' ? 'monthly' : b.repeat === 'weekly' ? 'weekly' : 'yearly'}{b.last_paid_on ? ` · last paid ${dateLabel(b.last_paid_on)}` : ''}</span></span>
              <b className="exp-amt">{money(b.amount, b.currency)}</b>
              <button className="btn sm" onClick={() => act(() => post(`/bills/${b.id}/pay`, {}), `Paid — next due ${dateLabel(nextLabel(b))}`)}>{t('Paid')}</button>
              <button className="btn ghost sm" aria-label={`Stop ${b.name}`} onClick={async () => { if (await confirm({ title: `Stop the “${b.name}” bill?`, body: 'Its reminder stops too. Past payments stay in your spending.', confirm: 'Stop' })) await act(() => del(`/bills/${b.id}`), 'Bill stopped'); }}><Icon name="x" size={15} /></button>
            </div>
          );
        })}
      </section>
    </>
  );
}

/** Rough next due date for the toast (the server works it out exactly). */
function nextLabel(b: any) {
  const [y, m, day] = String(b.next_due).split('-').map(Number);
  if (b.repeat === 'weekly') return new Date(Date.UTC(y, m - 1, day + 7)).toISOString().slice(0, 10);
  if (b.repeat === 'yearly') return `${y + 1}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const last = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 0)).getUTCDate();
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

function Debts({ d, cur, withBook, act }: { d: any; cur: string; withBook: (b: any) => any; act: Act }) {
  const amountOf = useAmount();
  const [paying, setPaying] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const owe = d.debts.filter((x: any) => x.direction === 'i_owe').reduce((a: number, x: any) => a + (x.currency === cur ? x.left : 0), 0);
  const owed = d.debts.filter((x: any) => x.direction === 'owed_to_me').reduce((a: number, x: any) => a + (x.currency === cur ? x.left : 0), 0);
  return (
    <>
      <section className="card pad money-summary" aria-label={t('Debts')}>
        <div className="ms-main"><span className="tiny muted">{t('You owe')}</span><span className="ms-total">{money(owe, cur)}</span></div>
        <div className="ms-week"><span className="tiny muted">{t('Owed to you')}</span><b>{money(owed, cur)}</b></div>
      </section>
      <QuickForm label={t('Add')} fields={[
        { name: 'direction', label: 'Which way', options: [['i_owe', 'I owe'], ['owed_to_me', 'Owes me']] },
        { name: 'person', label: 'Person', placeholder: 'Name', required: true },
        { name: 'amount', label: `Amount (${cur})`, type: 'amount', placeholder: '50k', required: true },
        { name: 'due_on', label: 'Due (optional)', type: 'date' },
      ]} onSubmit={async (v) => {
        const amount = amountOf(v.amount);
        if (amount === null) return false;
        await act(() => post('/debts', withBook({ direction: v.direction, person: v.person.trim(), amount, due_on: v.due_on || undefined })), 'Recorded');
      }} />
      <section className="card pad" aria-label={t('Open debts')}>
        <h2>{t('Open')}</h2>
        {!d.debts.length ? <Empty icon="user" title={t('Nothing owed')}>{t('Record money lent or borrowed, and payments as they come.')}</Empty> : d.debts.map((x: any) => (
          <div key={x.id} className="exp-row" style={{ flexWrap: 'wrap' }}>
            <span className="grow"><span className="exp-title">{x.direction === 'i_owe' ? `You owe ${x.person}` : `${x.person} owes you`}</span>
              <span className={`tiny ${x.due_on && x.due_on < d.today ? 'warn-text' : 'muted'}`}>{x.paid > 0 ? `${money(x.paid, x.currency)} paid of ${money(x.amount, x.currency)}` : `Since ${dateLabel(String(x.created_at).slice(0, 10))}`}{x.due_on ? ` · due ${dateLabel(x.due_on)}` : ''}</span></span>
            <b className="exp-amt">{money(x.left, x.currency)}</b>
            {paying === x.id ? (
              <span className="row" style={{ gap: 6 }}>
                <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder={t('Amount')} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} autoFocus aria-label={t('Amount paid')} />
                <button className="btn sm primary" onClick={async () => { const a = amountOf(payAmount); if (a === null) return; await act(() => post(`/debts/${x.id}/pay`, { amount: a }), 'Payment recorded'); setPaying(null); setPayAmount(''); }}>{t('Save')}</button>
              </span>
            ) : <button className="btn sm" onClick={() => { setPaying(x.id); setPayAmount(String(x.left)); }}>{t('Payment')}</button>}
          </div>
        ))}
      </section>
    </>
  );
}

function Savings({ d, cur, withBook, act }: { d: any; cur: string; withBook: (b: any) => any; act: Act }) {
  const amountOf = useAmount();
  const [moving, setMoving] = useState<string | null>(null);
  const [moveAmount, setMoveAmount] = useState('');
  return (
    <>
      <QuickForm label={t('Add goal')} fields={[
        { name: 'name', label: 'Saving for', placeholder: 'Laptop, school fees…', required: true },
        { name: 'target', label: `Target (${cur})`, type: 'amount', placeholder: '2m', required: true },
        { name: 'deadline', label: 'By (optional)', type: 'date' },
      ]} onSubmit={async (v) => {
        const target = amountOf(v.target);
        if (target === null) return false;
        await act(() => post('/savings', withBook({ name: v.name.trim(), target, deadline: v.deadline || undefined })), 'Goal added');
      }} />
      <section className="card pad" aria-label={t('Savings goals')}>
        <h2>{t('Goals')}</h2>
        {!d.goals.length ? <Empty icon="target" title={t('No goals yet')}>{t('Set something to save for, and add to it as you go.')}</Empty> : d.goals.map((g: any) => (
          <div key={g.id} className="budget-row" style={{ cursor: 'default' }}>
            <span className="row"><b className="grow">{g.name}{g.status === 'reached' ? ' ✓' : ''}</b><span className="small">{money(g.saved, g.currency)} <span className="muted">of {money(g.target, g.currency)}</span></span></span>
            <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={g.percent} aria-label={`${g.name}: ${g.percent}% saved`}><span style={{ width: `${g.percent}%` }} /></span>
            <span className="row" style={{ gap: 6 }}>
              <span className="tiny muted grow">{g.deadline ? `By ${dateLabel(g.deadline)}` : ''}{g.status === 'reached' ? ' · reached' : ''}</span>
              {moving === g.id ? (
                <>
                  <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder={t('+50k or -10k')} value={moveAmount} onChange={(e) => setMoveAmount(e.target.value)} autoFocus aria-label={t('Amount to add or take out')} />
                  <button className="btn sm primary" onClick={async () => {
                    const neg = moveAmount.trim().startsWith('-');
                    const a = amountOf(moveAmount.replace(/^[+-]/, ''));
                    if (a === null) return;
                    await act(() => post(`/savings/${g.id}/move`, { amount: neg ? -a : a }), neg ? 'Taken out' : 'Added');
                    setMoving(null);
                    setMoveAmount('');
                  }}>{t('Save')}</button>
                </>
              ) : <button className="btn sm" onClick={() => setMoving(g.id)}>{t('Add money')}</button>}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
