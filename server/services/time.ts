import * as chrono from 'chrono-node';

/** Offset in minutes of an IANA timezone at a given instant (e.g. Africa/Kampala → 180). */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

export function safeTimeZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Local HH:MM and weekday (0=Sun) of an instant in a timezone. */
export function localClock(at: Date, timeZone: string): { hhmm: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(at);
  const h = parts.find((p) => p.type === 'hour')!.value;
  const m = parts.find((p) => p.type === 'minute')!.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')!.value);
  return { hhmm: `${h}:${m}`, weekday: wd };
}

/** UTC instant for the start of a local day (YYYY-MM-DD) in a timezone. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d));
  return new Date(guess.getTime() - tzOffsetMinutes(timeZone, guess) * 60000);
}

export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

export function formatLocal(iso: string, timeZone: string, locale = 'en-GB', withTime = true): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(iso));
}

export interface ParsedWhen {
  iso: string;
  allDay: boolean;
  matchedText: string;
  /** Plain-language reasons the user should confirm before saving. */
  ambiguities: string[];
  /** The request with the date phrase removed — useful as a task title. */
  remainder: string;
}

/** Default hours for vague parts of day. */
const DAYPARTS: [RegExp, number][] = [
  [/\bmorning\b/i, 9],
  [/\b(noon|midday|lunch ?time)\b/i, 12],
  [/\bafternoon\b/i, 14],
  [/\bevening\b/i, 18],
  [/\btonight\b|\bnight\b/i, 20],
];

/**
 * Parses natural-language dates ("tomorrow morning", "next Friday at 3pm") relative to
 * `now` in the user's timezone. Vague phrases get a default time and an ambiguity note
 * so the UI can ask the user to confirm.
 */
export function parseWhen(text: string, now: Date, timeZone: string): ParsedWhen | null {
  const offset = tzOffsetMinutes(timeZone, now);
  const results = chrono.parse(text, { instant: now, timezone: offset }, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  const ambiguities: string[] = [];
  const start = r.start;
  let date = start.date();
  let allDay = false;

  if (!start.isCertain('hour')) {
    const daypart = DAYPARTS.find(([re]) => re.test(text));
    const localDay = localDate(date, timeZone);
    const dayStart = startOfLocalDay(localDay, timeZone);
    if (daypart) {
      date = new Date(dayStart.getTime() + daypart[1] * 3600_000);
      ambiguities.push(`No exact time was given, so I used ${String(daypart[1]).padStart(2, '0')}:00.`);
    } else {
      date = new Date(dayStart.getTime() + 9 * 3600_000);
      allDay = true;
      ambiguities.push('No time was given — treated as an all-day item (reminder at 09:00).');
    }
  } else if (!start.isCertain('meridiem') && (start.get('hour') ?? 0) <= 12 && !/\d{1,2}:\d{2}/.test(r.text)) {
    ambiguities.push('AM or PM was not specified.');
  }
  if (date.getTime() < now.getTime() - 60_000) ambiguities.push('That time is in the past.');

  const remainder = (text.slice(0, r.index) + text.slice(r.index + r.text.length))
    .replace(/\b(remind me( to)?|reminder( to)?|on|at|by)\s*$/i, '')
    .replace(/^\s*(remind me( to)?|please)\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^to\s+/i, '');

  return { iso: date.toISOString(), allDay, matchedText: r.text, ambiguities, remainder };
}
