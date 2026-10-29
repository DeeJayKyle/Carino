import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setup, signup, text, type TestCtx } from './helpers.ts';
import { OpenAICompatProvider } from '../server/ai/openai-compat.ts';

let ctx: TestCtx;
beforeEach(() => (ctx = setup()));
afterEach(() => ctx.cleanup());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]);

const form = (name: string, content: Buffer | string) => {
  const f = new FormData();
  f.append('file', new File([content as BlobPart], name));
  return f;
};

async function uploadImage(c: Awaited<ReturnType<typeof signup>>, name = 'shelf.png', body: Buffer = PNG) {
  const r = await c.req('POST', '/api/documents', form(name, body));
  expect(r.status).toBe(201);
  return r.data.document;
}

async function ask(c: Awaited<ReturnType<typeof signup>>, convId: string, msg: string, attachments: string[]) {
  return c.post(`/api/conversations/${convId}/messages`, { text: msg, attachments });
}

describe('image attachments', () => {
  it('stores images by their real type and previews them safely', async () => {
    const c = await signup(ctx);
    const doc = await uploadImage(c, 'photo.jpg', JPEG);
    expect(doc.kind).toBe('image');
    const p = await c.get(`/api/documents/${doc.id}/preview`);
    expect(p.headers.get('content-type')).toBe('image/jpeg');
    expect(p.headers.get('content-security-policy')).toContain('sandbox');
    // A PNG name on JPEG bytes is stored as what it really is.
    expect((await uploadImage(c, 'renamed.png', JPEG)).kind).toBe('image');
    expect((await c.get(`/api/documents/${(await uploadImage(c, 'renamed2.png', JPEG)).id}/preview`)).headers.get('content-type')).toBe('image/jpeg');
  });

  it('rejects fake and oversized images, and never previews other kinds', async () => {
    const c = await signup(ctx);
    const fake = await c.req('POST', '/api/documents', form('cat.png', 'just text'));
    expect(fake.status).toBe(400);
    expect(fake.data.error).toMatch(/not a valid/);
    const big = await c.req('POST', '/api/documents', form('big.png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)])));
    expect(big.status).toBe(400);
    expect(big.data.error).toMatch(/up to 5 MB/);
    const note = (await c.req('POST', '/api/documents', form('a.txt', 'hello'))).data.document;
    expect((await c.get(`/api/documents/${note.id}/preview`)).status).toBe(400);
  });

  it('sends attached images to a model that can see them', async () => {
    const c = await signup(ctx);
    ctx.provider.vision = true;
    const img = await uploadImage(c);
    const conv = (await c.post('/api/conversations', {})).data;
    ctx.provider.steps.push(() => text('The top shelf is nearly empty.'));
    await ask(c, conv.id, 'What is running low here?', [img.id]);
    const last = ctx.provider.calls[0].messages.at(-1)!;
    const image = last.content.find((b: any) => b.type === 'image') as any;
    expect(image.source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG.toString('base64') });
    expect(JSON.stringify(last.content)).toContain('kind=\\"image\\"');
    // History keeps a reference, not the bytes.
    const stored = ctx.services.db.get("SELECT api_content, meta FROM messages WHERE role = 'user'")!;
    expect(stored.api_content).not.toContain(PNG.toString('base64'));
    expect(JSON.parse(stored.meta).attachments[0]).toMatchObject({ id: img.id, kind: 'image' });
  });

  it('tells a model that cannot see images instead of sending them', async () => {
    const c = await signup(ctx);
    const img = await uploadImage(c);
    const conv = (await c.post('/api/conversations', {})).data;
    ctx.provider.steps.push(() => text('I can’t view images with this model.'));
    await ask(c, conv.id, 'What is this?', [img.id]);
    const sent = JSON.stringify(ctx.provider.calls[0].messages);
    expect(sent).not.toContain('"type":"image"');
    expect(sent).toContain('cannot view images');
  });

  it('re-sends only the most recent images in a long conversation', async () => {
    const c = await signup(ctx);
    ctx.provider.vision = true;
    const conv = (await c.post('/api/conversations', {})).data;
    for (let n = 0; n < 5; n++) {
      const img = await uploadImage(c, `p${n}.png`);
      ctx.provider.steps.push(() => text('ok'));
      await ask(c, conv.id, `photo ${n}`, [img.id]);
    }
    const msgs = ctx.provider.calls.at(-1)!.messages;
    expect(msgs.flatMap((m) => m.content).filter((b: any) => b.type === 'image')).toHaveLength(4);
    expect(JSON.stringify(msgs)).toContain('Earlier image \\"p0.png\\"');
  });

  it('converts images to the OpenAI-compatible format', async () => {
    let body: any;
    const p = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'm', label: 'L', tools: false, vision: true }, async (_u, init) => {
      body = JSON.parse(String(init!.body));
      return new Response('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    expect(p.info().capabilities.vision).toBe(true);
    await p.chat({ system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] });
    expect(body.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] });
  });
});
