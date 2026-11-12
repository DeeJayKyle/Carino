import { z } from 'zod';
import type { ToolDef } from './registry.ts';
import { getSettings } from '../services/settings.ts';

/**
 * Food and travel: Carino prepares searches and ready links in the services people already use
 * (ordering and booking need business agreements, so the user finishes there). Nothing is ordered
 * or booked by Carino.
 */
const def = <S extends z.ZodType>(d: ToolDef<S>) => d as unknown as ToolDef;
const q = encodeURIComponent;

/** Delivery services by country (ISO code from the user's region setting). */
const DELIVERY: Record<string, { name: string; url: (food: string, place: string) => string }[]> = {
  UG: [{ name: 'Glovo', url: (f) => `https://glovoapp.com/ug/en/kampala/search/?query=${q(f)}` }, { name: 'Jumia Food', url: () => 'https://food.jumia.ug/' }, { name: 'SafeBoda', url: () => 'https://www.safeboda.com/ug/' }],
  KE: [{ name: 'Glovo', url: (f) => `https://glovoapp.com/ke/en/nairobi/search/?query=${q(f)}` }, { name: 'Uber Eats', url: (f) => `https://www.ubereats.com/search?q=${q(f)}` }, { name: 'Bolt Food', url: () => 'https://food.bolt.eu/' }],
  NG: [{ name: 'Chowdeck', url: () => 'https://chowdeck.com/' }, { name: 'Glovo', url: (f) => `https://glovoapp.com/ng/en/lagos/search/?query=${q(f)}` }],
  GB: [{ name: 'Deliveroo', url: (f, p) => `https://deliveroo.co.uk/search?q=${q(f)}${p ? `&postcode=${q(p)}` : ''}` }, { name: 'Uber Eats', url: (f) => `https://www.ubereats.com/gb/search?q=${q(f)}` }, { name: 'Just Eat', url: () => 'https://www.just-eat.co.uk/' }],
  US: [{ name: 'DoorDash', url: (f) => `https://www.doordash.com/search/store/${q(f)}/` }, { name: 'Uber Eats', url: (f) => `https://www.ubereats.com/search?q=${q(f)}` }, { name: 'Grubhub', url: () => 'https://www.grubhub.com/' }],
};
const DEFAULT_DELIVERY = [{ name: 'Uber Eats', url: (f: string) => `https://www.ubereats.com/search?q=${q(f)}` }, { name: 'Glovo', url: () => 'https://glovoapp.com/' }];

export const LIFE_TOOLS: ToolDef[] = [
  def({
    name: 'food_options',
    description: 'Help the user get food: nearby places that serve it (map links) plus ready search links in the delivery apps used in their country. Carino can’t order; the user finishes in the app. Combine with find_places for more detail.',
    risk: 'read',
    input: z.object({ food: z.string().min(2).max(120).describe('What they want, e.g. "pizza" or "rolex"'), near: z.string().max(200).optional().describe('Area or address') }),
    summarize: (i) => `Find ${i.food}${i.near ? ` near ${i.near}` : ''}`,
    run: async (i, ctx) => {
      const s = getSettings(ctx.services.db, ctx.userId);
      const country = s.regional.locale.split('-')[1]?.toUpperCase() ?? '';
      const apps = DELIVERY[country] ?? DEFAULT_DELIVERY;
      const where = i.near ? ` near ${i.near}` : '';
      return {
        map: `https://www.openstreetmap.org/search?query=${q(`${i.food}${where}`)}`,
        google_maps: `https://www.google.com/maps/search/${q(`${i.food}${where}`)}`,
        delivery: apps.map((a) => ({ app: a.name, link: a.url(i.food, i.near ?? '') })),
        note: 'Show these as links. Carino doesn’t place orders or pay.',
      };
    },
  }),
  def({
    name: 'trip_options',
    description: 'Ready search links for a trip: flights, places to stay and getting around, with the dates filled in. Carino can’t book or pay; the user compares and books themselves. Use web_search for prices or visa rules.',
    risk: 'read',
    input: z.object({
      to: z.string().min(2).max(120).describe('Destination city or place'),
      from: z.string().max(120).optional().describe('Departure city (for flights)'),
      depart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      return: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      travellers: z.number().int().min(1).max(12).optional(),
    }),
    summarize: (i) => `Trip links for ${i.to}`,
    run: async (i) => {
      const n = i.travellers ?? 1;
      const dates = i.depart ? ` ${i.depart}${i.return ? ` to ${i.return}` : ''}` : '';
      const stay = new URL('https://www.booking.com/searchresults.html');
      stay.searchParams.set('ss', i.to);
      stay.searchParams.set('group_adults', String(n));
      if (i.depart) stay.searchParams.set('checkin', i.depart);
      if (i.return) stay.searchParams.set('checkout', i.return);
      return {
        flights: i.from ? [
          { site: 'Google Flights', link: `https://www.google.com/travel/flights?q=${q(`Flights from ${i.from} to ${i.to}${dates} for ${n}`)}` },
          { site: 'Skyscanner', link: `https://www.skyscanner.net/transport/flights-from/${q(i.from)}/?q=${q(i.to)}` },
        ] : [],
        stays: [
          { site: 'Booking.com', link: stay.href },
          { site: 'Airbnb', link: `https://www.airbnb.com/s/${q(i.to)}/homes?adults=${n}${i.depart ? `&checkin=${i.depart}` : ''}${i.return ? `&checkout=${i.return}` : ''}` },
        ],
        getting_around: [
          { site: 'Map', link: `https://www.openstreetmap.org/search?query=${q(i.to)}` },
          { site: 'Rome2Rio', link: `https://www.rome2rio.com/map/${q(i.from ?? '')}/${q(i.to)}` },
        ],
        note: 'Show these as links. Offer to add the trip to the calendar, a packing list, or reminders for check-in.',
      };
    },
  }),
];

// ---- Bank and mobile-money statements -------------------------------------------------------

async function statementOf(ctx: Parameters<ToolDef['run']>[1], documentId: string) {
  const { loadSheets } = await import('../services/documents.ts');
  const { readStatement } = await import('../services/statement.ts');
  const doc = ctx.services.db.getOwned('documents', ctx.userId, documentId);
  if (!doc) throw new Error('That file isn’t in the user’s documents. Ask them to attach the statement (CSV or Excel).');
  const sheets = await loadSheets(doc).catch(() => { throw new Error('Statements must be CSV or Excel files. Most banking apps can export one; a PDF can’t be imported.'); });
  return readStatement(sheets[0]);
}

LIFE_TOOLS.push(
  def({
    name: 'read_bank_statement',
    description: 'Read a bank or mobile-money statement the user attached (CSV or Excel): totals in and out, and the rows. Use before import_bank_statement to show the user what would be added.',
    risk: 'read',
    input: z.object({ document_id: z.string().min(1).max(64) }),
    summarize: () => 'Read a bank statement',
    run: async (i, ctx) => {
      const { guessCategory } = await import('../services/statement.ts');
      const s = await statementOf(ctx, i.document_id);
      const out = s.rows.filter((r) => r.amount < 0);
      const inn = s.rows.filter((r) => r.amount > 0);
      const sum = (rs: typeof s.rows) => Math.round(rs.reduce((a, r) => a + Math.abs(r.amount), 0) * 100) / 100;
      return {
        rows: s.rows.length, skipped: s.skipped, from: s.rows.map((r) => r.date).sort()[0], to: s.rows.map((r) => r.date).sort().at(-1),
        money_out: sum(out), money_in: sum(inn),
        sample: s.rows.slice(0, 40).map((r) => ({ ...r, category: r.amount < 0 ? guessCategory(r.description) : 'income' })),
        untrusted_content: true,
      };
    },
  }),
  def({
    name: 'import_bank_statement',
    description: 'Add a statement’s rows to Money: money out as spending (category guessed from the description), money in as income. Rows already recorded (same day and amount) are skipped, so importing twice is safe. Optionally only rows from/to a date.',
    risk: 'reversible',
    input: z.object({
      document_id: z.string().min(1).max(64),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      include_income: z.boolean().optional().describe('Also add money in as income (default true)'),
    }),
    summarize: (i) => `Add a bank statement to Money${i.from || i.to ? ` (${i.from ?? '…'} to ${i.to ?? '…'})` : ''}`,
    run: async (i, ctx) => {
      const { guessCategory } = await import('../services/statement.ts');
      const money = await import('../services/money.ts');
      const finance = await import('../services/finance.ts');
      const { localDate } = await import('../services/time.ts');
      const s = await statementOf(ctx, i.document_id);
      const today = localDate(ctx.services.now(), getSettings(ctx.services.db, ctx.userId).regional.timeZone);
      const currency = money.currencyFor(getSettings(ctx.services.db, ctx.userId));
      let spent = 0, income = 0, duplicates = 0, skipped = s.skipped;
      for (const r of s.rows.slice(0, 2000)) {
        if ((i.from && r.date < i.from) || (i.to && r.date > i.to) || r.date > today) { skipped++; continue; }
        if (r.amount < 0) {
          const category = guessCategory(r.description);
          const values = { amount: -r.amount, currency, category, spent_on: r.date };
          // Already recorded (by hand, from a receipt or an earlier import): same day and amount.
          if (ctx.services.db.get('SELECT id FROM expenses WHERE user_id = ? AND book_id IS NULL AND amount = ? AND currency = ? AND spent_on = ?', ctx.userId, values.amount, currency, r.date)) { duplicates++; continue; }
          ctx.services.db.insert('expenses', { user_id: ctx.userId, book_id: null, ...values, note: r.description.slice(0, 300), merchant: '', source: 'statement', updated_at: new Date().toISOString() });
          spent++;
        } else if (i.include_income !== false) {
          const same = ctx.services.db.get('SELECT id FROM income WHERE user_id = ? AND book_id IS NULL AND amount = ? AND received_on = ?', ctx.userId, r.amount, r.date);
          if (same) { duplicates++; continue; }
          finance.addIncome(ctx.services.db, ctx.userId, { amount: r.amount, note: r.description.slice(0, 300), received_on: r.date }, { today, currency, book: null });
          income++;
        }
      }
      return { added_spending: spent, added_income: income, skipped_duplicates: duplicates, skipped_other: skipped, currency };
    },
  }),
);
