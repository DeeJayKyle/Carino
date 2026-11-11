import { useState, type FormEvent } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading, Modal, useConfirm, useToast } from '../components/ui';
import { useData } from '../lib/hooks';
import { del, patch, post, put } from '../lib/api';
import { MoneyMore } from './MoneyMore';
import { Link } from '../lib/router';
import { getPrefs, money, parseAmount } from '../lib/format';
import { writeOrQueue, isQueued, isConflict } from '../lib/sync';

const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const monthLabel = (month: string) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString(getPrefs().locale || undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (day: string, today: string) => {
  if (day === today) return 'Today';
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (day === y.toISOString().slice(0, 10)) return 'Yesterday';
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(getPrefs().locale || undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};

type Cat = { id: string; label: string };

export default function Money() {
  const toast = useToast();
  const confirm = useConfirm();
  const [month, setMonth] = useState<string | null>(null);
  const [book, setBook] = useState<string | null>(() => { try { return localStorage.getItem('carino.money.book') || null; } catch { return null; } });
  const [tab, setTab] = useState<'spending' | 'income' | 'bills' | 'debts' | 'savings'>('spending');
  const [newBook, setNewBook] = useState<string | null>(null);
  const q = new URLSearchParams({ ...(month ? { month } : {}), ...(book ? { book } : {}) }).toString();
  const { data: d, error, loading, reload } = useData<any>(`/money${q ? `?${q}` : ''}`);
  const pickBook = (id: string | null) => {
    setBook(id);
    try { if (id) localStorage.setItem('carino.money.book', id); else localStorage.removeItem('carino.money.book'); } catch { /* not saved */ }
  };
  // A book that was deleted (on another device) falls back to Personal.
  if (d && book && d.book !== book && error == null) queueMicrotask(() => pickBook(null));
  const withBook = (body: any) => (book ? { ...body, book } : body);
  const [editBudget, setEditBudget] = useState<{ category: string; amount: string } | null>(null);
  const [editCurrency, setEditCurrency] = useState<string | null>(null);

  const shown = month ?? d?.month;
  const isCurrent = d && d.month === d.today.slice(0, 7);
  const categories: Cat[] = d?.categories ?? [];
  const label = (id: string) => (id === 'total' ? 'Everything' : categories.find((c) => c.id === id)?.label ?? id);
  const cur: string = d?.currency ?? 'USD';

  const [editing, setEditing] = useState<any | null>(null);
  const act = async (fn: () => Promise<any>, ok?: string) => {
    try {
      const res = await fn();
      if (isQueued(res)) toast('Saved on this device — it will sync when the connection is back.');
      else if (isConflict(res)) toast('This was changed elsewhere since you opened it. Review it under “changes to check”.', 'error');
      else if (ok) toast(ok);
      if (res?.possible_duplicate) toast('The same amount was logged a few minutes ago — delete one if it was logged twice.', 'error');
      for (const a of res?.alerts ?? []) toast(a.title, a.level === 100 ? 'error' : 'info');
    } catch (e: any) {
      toast(e?.message ?? 'That did not work', 'error');
    }
    reload();
  };

  const removeExpense = async (e: any) => {
    if (!(await confirm({ title: 'Delete this expense?', body: `${money(e.amount, e.currency)}${e.note ? ` · ${e.note}` : ''}`, danger: true, confirm: 'Delete' }))) return;
    act(() => del(`/expenses/${e.id}`), 'Deleted');
  };

  const saveBudget = async () => {
    if (!editBudget) return;
    const amount = editBudget.amount.trim() === '' ? 0 : parseAmount(editBudget.amount);
    if (amount === null) return toast('Enter an amount, e.g. 300000 or 300k', 'error');
    setEditBudget(null);
    act(() => put('/budgets', withBook({ category: editBudget.category, amount })), amount ? 'Budget saved' : 'Budget removed');
  };

  const saveCurrency = async () => {
    const c = (editCurrency ?? '').trim().toUpperCase();
    if (c && !/^[A-Z]{3}$/.test(c)) return toast('Use a 3-letter code like UGX, KES or USD', 'error');
    setEditCurrency(null);
    act(() => patch('/settings', { money: { currency: c } }), 'Currency saved');
  };

  const groups: [string, any[]][] = [];
  for (const e of d?.expenses ?? []) {
    const last = groups[groups.length - 1];
    if (last && last[0] === e.spent_on) last[1].push(e);
    else groups.push([e.spent_on, [e]]);
  }
  const budgetCats = new Set((d?.budgets ?? []).map((b: any) => b.category));
  const maxCat = Math.max(1, ...(d?.byCategory ?? []).map((c: any) => c.total));

  return (
    <Shell title="Money">
      <div className="page money-page">
        <div className="page-head"><div>
          <h1>Money</h1>
          <p className="sub">What you spend and your monthly budgets. Tell Carino in chat — “spent 15k on lunch” — or send a photo of a receipt.</p>
        </div></div>

        {loading && !d ? <Loading rows={4} /> : error && !d ? <ErrorBox error={error} retry={reload} /> : d && (
          <>
            <div className="row wrap book-bar" role="group" aria-label="Money book">
              {d.books.map((b: any) => (
                <button key={b.id ?? 'personal'} className={`chip${(b.id ?? null) === (d.book ?? null) ? ' on' : ''}`} aria-pressed={(b.id ?? null) === (d.book ?? null)} onClick={() => pickBook(b.id)}>
                  <Icon name={b.id ? 'briefcase' : 'user'} size={14} />{b.name}
                </button>
              ))}
              <button className="chip" onClick={() => setNewBook('')}><Icon name="plus" size={14} />New book</button>
            </div>
            {d.book && <p className="tiny muted" style={{ margin: '-4px 0 10px' }}>Kept apart from your personal money: it isn’t in your daily brief or budgets. <button className="linklike" onClick={async () => {
              if (!(await confirm({ title: `Delete the “${d.books.find((b: any) => b.id === d.book)?.name}” book?`, body: 'Everything recorded in it — spending, income, bills, debts and savings — is deleted. Personal money isn’t touched.', danger: true, confirm: 'Delete book' }))) return;
              await act(() => del(`/money/books/${d.book}`), 'Book deleted');
              pickBook(null);
            }}>Delete this book</button></p>}

            <div className="tabs" role="tablist" aria-label="Money">
              {([['spending', 'Spending'], ['income', 'Income'], ['bills', `Bills${d.bills.length ? ` (${d.bills.length})` : ''}`], ['debts', `Debts${d.debts.length ? ` (${d.debts.length})` : ''}`], ['savings', 'Savings']] as const).map(([id, l]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>
              ))}
            </div>

            {tab !== 'spending' ? <MoneyMore tab={tab} d={d} cur={cur} withBook={withBook} act={act} /> : <>
            <div className="month-nav" role="group" aria-label="Month">
              <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(shown, -1))} aria-label="Previous month"><Icon name="chevron" size={16} style={{ transform: 'rotate(180deg)' }} /></button>
              <b className="grow">{monthLabel(shown)}</b>
              <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(shown, 1))} disabled={isCurrent} aria-label="Next month"><Icon name="chevron" size={16} /></button>
            </div>

            <section className="card pad money-summary" aria-label="Summary">
              <div className="ms-main">
                <span className="tiny muted">{isCurrent ? 'Spent this month' : 'Spent'}</span>
                <span className="ms-total">{money(d.total, cur)}</span>
                <span className="small muted">{d.count} purchase{d.count === 1 ? '' : 's'}{d.other.length ? ` · plus ${d.other.map((o: any) => money(o.total, o.currency)).join(', ')}` : ''}</span>
                {d.income > 0 && <span className="small">{money(d.income, cur)} came in · <b className={d.net < 0 ? 'warn-text' : ''}>{money(d.net, cur)} {d.net < 0 ? 'more out than in' : 'left over'}</b></span>}
              </div>
              {isCurrent && (
                <div className="ms-week">
                  <span className="tiny muted">Last 7 days</span>
                  <b>{money(d.week.total, cur)}</b>
                  <span className="small muted">
                    {d.week.previous > 0 ? `${d.week.total > d.week.previous ? 'Up' : d.week.total < d.week.previous ? 'Down' : 'Same'} from ${money(d.week.previous, cur)}` : d.week.top ? `Most on ${d.week.top.label}` : 'Nothing logged'}
                  </span>
                </div>
              )}
            </section>

            {isCurrent && <AddExpense categories={categories} currency={cur} today={d.today} onAdd={(body) => act(() => writeOrQueue('POST', '/expenses', withBook(body), { label: `Spending: ${money(body.amount, cur)}` }), 'Logged')} />}

            <section className="card pad" aria-label="Budgets">
              <div className="row"><h2 className="grow">Monthly budgets</h2>
                <button className="btn ghost sm" onClick={() => setEditBudget({ category: categories.find((c) => !budgetCats.has(c.id))?.id ?? 'total', amount: '' })}><Icon name="plus" size={14} />Add budget</button>
              </div>
              {!d.budgets.length ? (
                <p className="small muted" style={{ marginTop: 6 }}>Set a limit for a month — for everything, or just eating out — and Carino warns you at 80% and if you go over.</p>
              ) : d.budgets.map((b: any) => {
                const over = b.spent > b.amount;
                return (
                  <button key={b.id} className={`budget-row${over ? ' over' : b.percent >= 80 ? ' near' : ''}`} onClick={() => setEditBudget({ category: b.category, amount: String(b.amount) })} aria-label={`Change the ${b.label} budget`}>
                    <span className="row"><b className="grow">{b.label}</b><span className="small">{money(b.spent, b.currency)} <span className="muted">of {money(b.amount, b.currency)}</span></span></span>
                    <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, b.percent)} aria-label={`${b.label}: ${b.percent}% used`}><span style={{ width: `${Math.min(100, b.percent)}%` }} /></span>
                    <span className="tiny muted">
                      {over ? `${money(b.spent - b.amount, b.currency)} over` : `${money(b.left, b.currency)} left`}
                      {b.perDayLeft ? ` · about ${money(Math.floor(b.perDayLeft), b.currency)} a day for ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}` : ''}
                    </span>
                  </button>
                );
              })}
            </section>

            {d.byCategory.length > 0 && (
              <section className="card pad" aria-label="By category">
                <h2>Where it went</h2>
                <ul className="cat-bars">
                  {d.byCategory.map((c: any) => (
                    <li key={c.category}>
                      <span className="small cb-label">{c.label}</span>
                      <span className="cb-bar"><span style={{ width: `${(c.total / maxCat) * 100}%` }} /></span>
                      <span className="small cb-val">{money(c.total, cur)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="card pad" aria-label="Expenses">
              <div className="row"><h2 className="grow">Spending</h2>
                <Link className="btn ghost sm" to={`/chat/new?q=${encodeURIComponent('Please log this receipt')}`}><Icon name="paperclip" size={14} />Receipt photo</Link>
              </div>
              {!groups.length ? (
                <Empty icon="wallet" title={isCurrent ? 'Nothing logged this month' : 'Nothing logged that month'}>Add one above, or tell Carino what you spent.</Empty>
              ) : groups.map(([day, list]) => (
                <div key={day} className="exp-day">
                  <div className="tiny muted exp-day-head">{dayLabel(day, d.today)}</div>
                  {list.map((e: any) => (
                    <div key={e.id} className="exp-row">
                      <span className="grow">
                        <span className="exp-title">{e.note || e.merchant || label(e.category)}</span>
                        <span className="tiny muted">{label(e.category)}{e.merchant && e.note ? ` · ${e.merchant}` : ''}{e.source === 'receipt' ? ' · from a receipt' : e.source === 'bill' ? ' · bill' : ''}</span>
                      </span>
                      <b className="exp-amt">{money(e.amount, e.currency)}</b>
                      <button className="btn ghost sm" onClick={() => setEditing(e)} aria-label={`Edit ${e.note || label(e.category)}`}><Icon name="edit" size={15} /></button>
                      <button className="btn ghost sm" onClick={() => removeExpense(e)} aria-label={`Delete ${e.note || label(e.category)}`}><Icon name="trash" size={15} /></button>
                    </div>
                  ))}
                </div>
              ))}
            </section>

            </>}
            <p className="small muted">
              Amounts are in <b>{cur}</b>. <button className="linklike" onClick={() => setEditCurrency(cur)}>Change currency</button>
            </p>
          </>
        )}
      </div>

      {editBudget && (
        <Modal title="Monthly budget" onClose={() => setEditBudget(null)} footer={<>
          <button className="btn ghost" onClick={() => setEditBudget(null)}>Cancel</button>
          <button className="btn primary" onClick={saveBudget}>Save</button>
        </>}>
          <div className="field">
            <label htmlFor="b-cat">For</label>
            <select id="b-cat" className="select" value={editBudget.category} onChange={(e) => setEditBudget({ ...editBudget, category: e.target.value })}>
              <option value="total">Everything</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="b-amt">Per month ({cur})</label>
            <input id="b-amt" className="input" inputMode="decimal" placeholder="e.g. 300k" value={editBudget.amount} onChange={(e) => setEditBudget({ ...editBudget, amount: e.target.value })} autoFocus />
            <span className="tiny muted">Leave empty to remove this budget.</span>
          </div>
        </Modal>
      )}

      {newBook !== null && (
        <Modal title="New money book" onClose={() => setNewBook(null)} footer={<>
          <button className="btn ghost" onClick={() => setNewBook(null)}>Cancel</button>
          <button className="btn primary" disabled={!newBook.trim()} onClick={async () => {
            try {
              const b = await post<any>('/money/books', { name: newBook.trim() });
              setNewBook(null);
              pickBook(b.id);
              toast('Book created');
            } catch (e: any) {
              toast(e.message, 'error');
            }
          }}>Create</button>
        </>}>
          <div className="field">
            <label htmlFor="nb">Name</label>
            <input id="nb" className="input" maxLength={40} placeholder="e.g. Pharmacy" value={newBook} onChange={(e) => setNewBook(e.target.value)} autoFocus />
            <span className="tiny muted">A separate book for a business or a project: its spending, income, bills, debts and savings are kept apart from your personal money.</span>
          </div>
        </Modal>
      )}

      {editing && (
        <EditExpense expense={editing} categories={categories} today={d.today} onClose={() => setEditing(null)}
          onSave={(changes) => {
            setEditing(null);
            // Only what changed is sent, with the version it was based on: if it changed elsewhere meanwhile, it's a conflict to review, not an overwrite.
            return act(() => writeOrQueue('PATCH', `/expenses/${editing.id}`, changes, { label: `Edit spending: ${editing.note || label(editing.category)}`, entity: `expenses:${editing.id}`, base: editing.updated_at ?? undefined }), 'Saved');
          }} />
      )}

      {editCurrency !== null && (
        <Modal title="Your currency" onClose={() => setEditCurrency(null)} footer={<>
          <button className="btn ghost" onClick={() => setEditCurrency(null)}>Cancel</button>
          <button className="btn primary" onClick={saveCurrency}>Save</button>
        </>}>
          <div className="field">
            <label htmlFor="cur">3-letter code</label>
            <input id="cur" className="input" maxLength={3} placeholder="UGX" value={editCurrency} onChange={(e) => setEditCurrency(e.target.value.toUpperCase())} autoFocus />
            <span className="tiny muted">Empty uses your region. Spending already logged keeps its currency; totals and budgets count only this one.</span>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

function AddExpense({ categories, currency, today, onAdd }: { categories: Cat[]; currency: string; today: string; onAdd: (body: any) => Promise<void> }) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('food');
  const [note, setNote] = useState('');
  const [day, setDay] = useState(today);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    if (n === null) return toast('Enter an amount, e.g. 15000 or 15k', 'error');
    setBusy(true);
    await onAdd({ amount: n, category, note: note.trim() || undefined, spent_on: day || today });
    setBusy(false);
    setAmount('');
    setNote('');
    setDay(today);
  };
  return (
    <form className="card pad add-expense" onSubmit={submit} aria-label="Add spending">
      <div className="field ae-amount"><label htmlFor="e-amt">Amount ({currency})</label><input id="e-amt" className="input" inputMode="decimal" placeholder="15k" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      <div className="field ae-cat"><label htmlFor="e-cat">For</label>
        <select id="e-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      <div className="field ae-note"><label htmlFor="e-note">Note</label><input id="e-note" className="input" placeholder="Lunch with Sam" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="field ae-day"><label htmlFor="e-day">Day</label><input id="e-day" type="date" className="input" max={today} value={day} onChange={(e) => setDay(e.target.value)} /></div>
      <button className="btn primary ae-go" disabled={busy || !amount.trim()}><Icon name="plus" size={16} />Add</button>
    </form>
  );
}

function EditExpense({ expense, categories, today, onClose, onSave }: { expense: any; categories: Cat[]; today: string; onClose: () => void; onSave: (changes: Record<string, unknown>) => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(String(expense.amount));
  const [category, setCategory] = useState(expense.category);
  const [note, setNote] = useState(expense.note ?? '');
  const [merchant, setMerchant] = useState(expense.merchant ?? '');
  const [day, setDay] = useState(expense.spent_on);
  const save = () => {
    const n = parseAmount(amount);
    if (n === null) return toast('Enter an amount, e.g. 15000 or 15k', 'error');
    const changes: Record<string, unknown> = {};
    if (n !== expense.amount) changes.amount = n;
    if (category !== expense.category) changes.category = category;
    if (note.trim() !== (expense.note ?? '')) changes.note = note.trim();
    if (merchant.trim() !== (expense.merchant ?? '')) changes.merchant = merchant.trim();
    if (day && day !== expense.spent_on) changes.spent_on = day;
    if (!Object.keys(changes).length) return onClose();
    onSave(changes);
  };
  return (
    <Modal title="Edit spending" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={save}>Save</button>
    </>}>
      <div className="stack">
        <div className="field"><label htmlFor="x-amt">Amount ({expense.currency})</label><input id="x-amt" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></div>
        <div className="field"><label htmlFor="x-cat">For</label>
          <select id="x-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="x-note">Note</label><input id="x-note" className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="field"><label htmlFor="x-merchant">Shop or person</label><input id="x-merchant" className="input" maxLength={120} value={merchant} onChange={(e) => setMerchant(e.target.value)} /></div>
        <div className="field"><label htmlFor="x-day">Day</label><input id="x-day" type="date" className="input" max={today} value={day} onChange={(e) => setDay(e.target.value)} /></div>
        {expense.source === 'receipt' && <p className="tiny muted">Logged from a receipt photo. That stays recorded when you edit it.</p>}
      </div>
    </Modal>
  );
}
