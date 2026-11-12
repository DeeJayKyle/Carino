import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';
import { executeTool, makeContext } from '../server/tools/registry.ts';
import { parseAmount, parseDate, readStatement, guessCategory } from '../server/services/statement.ts';
import { parseCsv } from '../server/services/spreadsheet.ts';
import { storeDocument } from '../server/services/documents.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

describe('statements', () => {
  it('reads amounts and dates the way banks write them', () => {
    expect(parseAmount('1,234.50')).toBe(1234.5);
    expect(parseAmount('1.234,50')).toBe(1234.5);
    expect(parseAmount('(500)')).toBe(-500);
    expect(parseAmount('UGX -15,000')).toBe(-15000);
    expect(parseDate('03/11/2026')).toBe('2026-11-03');
    expect(parseDate('25/10/2026')).toBe('2026-10-25');
    expect(parseDate('7 Nov 2026')).toBe('2026-11-07');
    expect(parseDate('2026-11-01T10:00')).toBe('2026-11-01');
  });

  it('finds the columns whatever the bank calls them', () => {
    const s = readStatement(parseCsv('Txn Date,Narration,Debit,Credit,Balance\n01/11/2026,UMEME YAKA,"50,000",,900000\n02/11/2026,Salary,,"2,000,000",2900000\nTotal,,,,\n'));
    expect(s.rows).toEqual([
      { date: '2026-11-01', description: 'UMEME YAKA', amount: -50000 },
      { date: '2026-11-02', description: 'Salary', amount: 2000000 },
    ]);
    expect(s.skipped).toBe(1);
    expect(guessCategory('UMEME YAKA')).toBe('bills');
  });

  it('imports into Money once, even when run twice', async () => {
    const c = await signup(ctx);
    const csv = 'Date,Description,Amount\n2020-01-05,Shoprite Lugogo,-80000\n2020-01-06,Client payment,500000\n';
    const { doc } = await storeDocument(ctx.services.db, ctx.services.config.DATA_DIR, c.user.id, { name: 'statement.csv', buf: Buffer.from(csv) }, {}, 5_000_000);
    await c.patch('/api/settings', { permissions: { tools: { import_bank_statement: 'auto' } } });
    const read: any = await executeTool('read_bank_statement', { document_id: doc.id }, makeContext(ctx.services, c.user.id, null));
    expect(read.error).toBeUndefined();
    expect(read.result.money_out).toBe(80000);
    const run = () => executeTool('import_bank_statement', { document_id: doc.id }, makeContext(ctx.services, c.user.id, null));
    const first: any = await run();
    expect(first.status).toBe('executed');
    expect(first.result.added_spending).toBe(1);
    expect(first.result.added_income).toBe(1);
    const second: any = await run();
    expect(second.result.skipped_duplicates).toBe(2);
  });
});

describe('food and travel', () => {
  it('gives delivery links for the user’s country and filled-in trip searches', async () => {
    const c = await signup(ctx);
    await c.patch('/api/settings', { regional: { locale: 'en-UG' } });
    const food: any = await executeTool('food_options', { food: 'rolex', near: 'Ntinda' }, makeContext(ctx.services, c.user.id, null));
    expect(food.result.delivery.map((d: any) => d.app)).toContain('Glovo');
    const trip: any = await executeTool('trip_options', { to: 'Zanzibar', from: 'Entebbe', depart: '2026-12-20', return: '2026-12-27', travellers: 2 }, makeContext(ctx.services, c.user.id, null));
    expect(trip.result.stays[0].link).toContain('checkin=2026-12-20');
    expect(trip.result.flights).toHaveLength(2);
  });
});
