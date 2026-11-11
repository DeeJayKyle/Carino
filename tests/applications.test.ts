import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, toolCall, type TestCtx } from './helpers.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());
// The clock starts at 2026-10-16 08:00 UTC (11:00 in Kampala).

const reminders = async (c: any) => (await c.get('/api/reminders')).data.reminders.filter((r: any) => r.status === 'scheduled');

describe('application tracker', () => {
  it('reminds before the deadline, and after applying, to follow up', async () => {
    const c = await signup(ctx);
    const a = (await c.post('/api/applications', { kind: 'scholarship', title: 'Masters scholarship', organisation: 'Example Trust', deadline: '2026-11-01', eligible: 'yes', eligibility: 'Degree, 2 years’ work' })).data;
    expect(a).toMatchObject({ status: 'interested', progress: { total: 0 } });
    let rem = await reminders(c);
    expect(rem).toHaveLength(1);
    expect(rem[0].title).toBe('Deadline 2026-11-01: Masters scholarship (Example Trust)');
    expect(rem[0].remind_at).toBe('2026-10-29T06:00:00.000Z'); // 3 days before, 9:00 Kampala

    const applied = (await c.patch(`/api/applications/${a.id}`, { status: 'applied' })).data;
    expect(applied).toMatchObject({ applied_on: '2026-10-16', follow_up_on: '2026-10-30' });
    rem = await reminders(c);
    expect(rem.map((r: any) => r.title)).toEqual(['Follow up: Masters scholarship at Example Trust']); // deadline reminder no longer needed
    expect(applied.events.map((e: any) => e.text)).toContain('Interested → Applied');

    const done = (await c.patch(`/api/applications/${a.id}`, { status: 'rejected' })).data;
    expect(done.follow_up_on).toBeNull();
    expect(await reminders(c)).toHaveLength(0);
  });

  it('edits change only what is sent', async () => {
    const c = await signup(ctx);
    const a = (await c.post('/api/applications', { title: 'Pharmacist', organisation: 'City Hospital', eligibility: 'Licensed', deadline: '2026-12-01' })).data;
    const b = (await c.patch(`/api/applications/${a.id}`, { notes: 'Ask about shifts' })).data;
    expect(b).toMatchObject({ title: 'Pharmacist', organisation: 'City Hospital', eligibility: 'Licensed', deadline: '2026-12-01', kind: 'job', notes: 'Ask about shifts' });
    expect((await c.patch(`/api/applications/${a.id}`, { user_id: 'x' })).status).toBe(400);
  });

  it('keeps a checklist of documents and referees, linked to saved files', async () => {
    const c = await signup(ctx);
    const a = (await c.post('/api/applications', { title: 'Pharmacist' })).data;
    const form = new FormData();
    form.set('file', new Blob(['CV: Herbert, pharmacist'], { type: 'text/plain' }), 'cv.txt');
    const docId = (await c.req('POST', '/api/documents', form)).data.document.id;
    await c.post(`/api/applications/${a.id}/items`, { kind: 'document', label: 'CV', document_id: docId });
    const ref = (await c.post(`/api/applications/${a.id}/items`, { kind: 'referee', label: 'Dr. A. Example', contact: 'a@example.org' })).data;
    let got = (await c.get(`/api/applications/${a.id}`)).data;
    expect(got.items.map((i: any) => [i.label, i.status, i.document_name ?? null])).toEqual([['CV', 'ready', 'cv.txt'], ['Dr. A. Example', 'needed', null]]);
    expect(got.progress).toEqual({ total: 2, ready: 1, missing: ['Dr. A. Example'] });
    await c.patch(`/api/application-items/${ref.id}`, { status: 'done' });
    got = (await c.get(`/api/applications/${a.id}`)).data;
    expect(got.progress.missing).toEqual([]);
  });

  it('is private to its owner', async () => {
    const c = await signup(ctx);
    const other = await signup(ctx, 'Other');
    const a = (await c.post('/api/applications', { title: 'Pharmacist' })).data;
    const item = (await c.post(`/api/applications/${a.id}/items`, { kind: 'requirement', label: 'Licence' })).data;
    expect((await other.get(`/api/applications/${a.id}`)).status).toBe(404);
    expect((await other.patch(`/api/applications/${a.id}`, { status: 'withdrawn' })).status).toBe(404);
    expect((await other.post(`/api/applications/${a.id}/items`, { kind: 'requirement', label: 'x' })).status).toBe(404);
    expect((await other.patch(`/api/application-items/${item.id}`, { status: 'done' })).status).toBe(404);
    expect((await other.get('/api/applications')).data.applications).toEqual([]);
  });

  it('the assistant tracks one from an advert and builds the checklist', async () => {
    const c = await signup(ctx);
    let appId = '';
    ctx.provider.steps.push(
      () => toolCall('track_application', { kind: 'job', title: 'Pharmacist', organisation: 'City Hospital', deadline: '2026-11-20', eligible: 'yes', eligibility: 'B.Pharm and a practising licence' }),
      (req) => {
        appId = JSON.parse((req.messages.at(-1)!.content[0] as any).content).application.id;
        return toolCall('application_checklist', { application_id: appId, kind: 'document', label: 'Cover letter' });
      },
      () => text('Tracked, with a reminder 3 days before the deadline.'),
    );
    const conv = (await c.post('/api/conversations', {})).data;
    await c.post(`/api/conversations/${conv.id}/messages`, { text: 'track this job: Pharmacist at City Hospital, closes 20 Nov, needs B.Pharm and licence' });
    const list = (await c.get('/api/applications')).data.applications;
    expect(list[0]).toMatchObject({ id: appId, title: 'Pharmacist', deadline: '2026-11-20', eligible: 'yes', progress: { missing: ['Cover letter'] } });
    expect((await c.get('/api/stuff')).data.applications).toEqual({ open: 1, dueSoon: 0 });
  });
});
