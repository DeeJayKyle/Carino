import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, type TestCtx } from './helpers.ts';
import { executeTool, makeContext } from '../server/tools/registry.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const run = async (c: any, name: string, input: unknown) => executeTool(name, input, makeContext(ctx.services, c.user.id, null));
const approve = async (c: any, out: any) => (out.status === 'pending_approval' ? (await c.post(`/api/actions/${out.actionId}/approve`)).data : out);

describe('making things', () => {
  it('makes a slide deck and a document the user can download', async () => {
    const c = await signup(ctx);
    const deck: any = await run(c, 'make_slides', { title: 'Q3 plan', slides: [{ title: 'Goals', bullets: ['Grow sales', 'Open a branch'] }] });
    expect(deck.result.filename).toBe('Q3 plan.pptx');
    const dl = await c.get(deck.result.download_url.replace('/api', '/api'));
    expect(dl.status).toBe(200);
    const doc: any = await run(c, 'make_document', { title: 'Cover letter', text: '# Dear team\n\nI would like to apply.' });
    expect(doc.result.filename).toBe('Cover letter.docx');
  });

  it('builds a page, keeps earlier versions, restores one, and serves it sandboxed', async () => {
    const c = await signup(ctx);
    const made: any = await run(c, 'make_page', { title: 'Party invite', html: '<h1>Come to my party</h1><script>1</script>' });
    const id = made.result.page_id;
    await run(c, 'make_page', { title: 'Party invite', html: '<h1>Party moved to Sunday</h1>', page_id: id });
    const page = (await c.get(`/api/pages/${id}`)).data;
    expect(page.version).toBe(2);
    expect(page.history.map((h: any) => h.version)).toEqual([1]);
    const html = await c.get(`/api/pages/${id}/html`);
    expect(html.headers.get('content-security-policy')).toMatch(/sandbox allow-scripts/);
    expect(Buffer.from(html.data).toString()).toContain('Sunday');
    expect(Buffer.from(html.data).toString()).toContain("default-src 'none'");
    await c.post(`/api/pages/${id}/restore`, { version: 1 });
    expect(Buffer.from((await c.get(`/api/pages/${id}/html`)).data).toString()).toContain('Come to my party');
    expect((await c.get('/api/pages')).data.pages).toHaveLength(1);
  });

  it('makes a picture with the user’s own OpenAI key, after asking', async () => {
    const c = await signup(ctx);
    ctx.services.providers.addConnection({ id: 'openai', label: 'OpenAI', api: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', local: false, billing: 'paid', models: [{ id: 'gpt-5-mini' }] });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    let sent: any;
    ctx.services.netFetch = (async (url: string, init: any) => {
      sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
    }) as any;
    const out: any = await run(c, 'generate_image', { prompt: 'A sunflower in watercolour', shape: 'portrait' });
    expect(out.status).toBe('pending_approval');
    const done = await approve(c, out);
    expect(done.status).toBe('executed');
    expect(sent.url).toBe('https://api.openai.com/v1/images/generations');
    expect(sent.body.size).toBe('1024x1536');
    expect(sent.auth).toBe('Bearer sk-test');
  });

  it('says plainly when no image service is set up', async () => {
    const c = await signup(ctx);
    const out: any = await approve(c, await run(c, 'generate_image', { prompt: 'A cat' }));
    expect(out.result?.error ?? out.error).toMatch(/OpenAI or Google Gemini key/);
  });
});

describe('sticker packs', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

  it('turns pictures into a WhatsApp sticker pack on the phone', async () => {
    const c = await signup(ctx);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const fd = new FormData();
      fd.append('file', new Blob([png], { type: 'image/png' }), `p${i}.png`);
      const r = await ctx.app.request('http://localhost/api/documents', { method: 'POST', body: fd, headers: { cookie: c.cookie, 'x-carino': '1' } });
      ids.push((await r.json()).document.id);
    }
    const made: string[] = [];
    ctx.services.stickers = {
      sticker: async (img) => { made.push('s'); return new Uint8Array(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ' + img.length)); },
      tray: async () => new Uint8Array(png),
    };
    const out: any = await run(c, 'make_stickers', { name: 'Family', document_ids: ids, emojis: ['😂', '❤️'] });
    expect(out.status).toBe('executed');
    expect(made).toHaveLength(3);
    expect(out.result.sticker_pack.stickers.map((s: any) => s.emoji)).toEqual(['😂', '❤️', '😀']);
    expect(out.result.sticker_pack.tray_document_id).toBeTruthy();
  });

  it('says stickers are made on the phone when this device can’t', async () => {
    const c = await signup(ctx);
    const out: any = await run(c, 'make_stickers', { name: 'X', document_ids: ['a', 'b', 'c'] });
    expect(out.result.error).toMatch(/Android phone/);
    expect((await run(c, 'make_stickers', { name: 'X', document_ids: ['a'] }) as any).status).toBe('error');
  });
});
