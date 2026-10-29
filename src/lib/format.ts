let prefs = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', locale: 'en-GB', hour12: false };

export function setFormatPrefs(p?: { timeZone?: string; locale?: string; hour12?: boolean }) {
  if (!p) return;
  prefs = { timeZone: p.timeZone || prefs.timeZone, locale: p.locale || prefs.locale, hour12: !!p.hour12 };
}
export const getPrefs = () => prefs;

const safe = (fn: () => string, fallback: string) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export function fmtDateTime(iso: string | null | undefined, opts: { time?: boolean; weekday?: boolean; year?: boolean } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  return safe(() => new Intl.DateTimeFormat(prefs.locale, {
    timeZone: prefs.timeZone, day: 'numeric', month: 'short',
    ...(opts.weekday ? { weekday: 'short' } : {}),
    ...(opts.year ? { year: 'numeric' } : {}),
    ...(opts.time !== false ? { hour: '2-digit', minute: '2-digit', hour12: prefs.hour12 } : {}),
  }).format(d), d.toISOString());
}

export function fmtTime(iso: string) {
  return safe(() => new Intl.DateTimeFormat(prefs.locale, { timeZone: prefs.timeZone, hour: '2-digit', minute: '2-digit', hour12: prefs.hour12 }).format(new Date(iso)), iso);
}

/** YYYY-MM-DD of an instant in the user's timezone. */
export function localDay(d: Date | string) {
  return safe(() => new Intl.DateTimeFormat('en-CA', { timeZone: prefs.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d)), String(d).slice(0, 10));
}

export function relative(iso: string) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(prefs.locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDateTime(iso, { time: false, year: true });
}

/** Describes a due date relative to today: "Today 14:00", "Tomorrow", "Mon 3 Nov", "Overdue · 2 Oct". */
export function dueLabel(iso: string | null, allDay = false) {
  if (!iso) return { text: '', overdue: false };
  const today = localDay(new Date());
  const day = localDay(iso);
  const tomorrow = localDay(new Date(Date.now() + 86400_000));
  const overdue = allDay ? day < today : new Date(iso).getTime() < Date.now();
  const time = allDay ? '' : ` ${fmtTime(iso)}`;
  if (day === today) return { text: `Today${time}`, overdue };
  if (day === tomorrow) return { text: `Tomorrow${time}`, overdue: false };
  return { text: `${overdue ? 'Overdue · ' : ''}${fmtDateTime(iso, { time: !allDay, weekday: true })}`, overdue };
}

/** Value for <input type="datetime-local"> in the user's timezone. */
export function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: prefs.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

/** Converts a datetime-local value (interpreted in the user's timezone) to ISO UTC. */
export function fromLocalInput(v: string) {
  if (!v) return null;
  const [d, t = '00:00'] = v.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  const offset = tzOffset(new Date(guess));
  return new Date(guess - offset * 60000).toISOString();
}

function tzOffset(at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: prefs.timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}
