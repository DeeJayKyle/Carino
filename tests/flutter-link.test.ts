import { describe, it, expect } from 'vitest';
import { makeLink } from '../mobile/flutter-link.ts';

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('Flutter link to the engine', () => {
  it('passes requests in and JSON, streamed and binary replies out', async () => {
    const seen: Request[] = [];
    const handle = async (req: Request) => {
      seen.push(req);
      const path = new URL(req.url).pathname;
      if (path === '/api/tasks') return Response.json({ tasks: [{ id: 't1' }] });
      if (path === '/api/stream') {
        const enc = new TextEncoder();
        return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('event: text\ndata: {"delta":"Hi"}\n\n')); c.enqueue(enc.encode('event: done\ndata: {}\n\n')); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path === '/api/file') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="a.pdf"' } });
      if (path === '/api/upload') {
        const f = (await req.formData()).get('file') as File;
        return Response.json({ name: f.name, size: f.size, type: f.type });
      }
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    };
    const out: any[] = [];
    const link = makeLink(handle, (m) => out.push(m), 'https://appassets.androidplatform.net');
    await link.request(JSON.stringify({ id: '1', method: 'POST', path: '/tasks', body: { title: 'x' } }));
    expect(out.at(-1)).toMatchObject({ id: '1', type: 'done', status: 200, body: '{"tasks":[{"id":"t1"}]}' });
    expect(seen[0].headers.get('x-carino')).toBe('1');
    expect(await seen[0].json()).toEqual({ title: 'x' });
    await link.request(JSON.stringify({ id: '2', method: 'POST', path: '/stream' }));
    const s = out.filter((m) => m.id === '2');
    expect(s[0]).toMatchObject({ type: 'head', status: 200 });
    expect(s.filter((m) => m.type === 'chunk').map((m) => m.text).join('')).toContain('"delta":"Hi"');
    expect(s.at(-1).type).toBe('end');
    await link.request(JSON.stringify({ id: '3', method: 'GET', path: '/file' }));
    expect(out.at(-1)).toMatchObject({ id: '3', b64: 'AQID', filename: 'a.pdf', contentType: 'application/pdf' });
    await link.request(JSON.stringify({ id: '4', method: 'POST', path: '/upload', upload: { files: [{ field: 'file', name: 'r.png', mime: 'image/png', b64: 'AQID' }] } }));
    expect(JSON.parse(out.at(-1).body)).toEqual({ name: 'r.png', size: 3, type: 'image/png' });
    await link.request(JSON.stringify({ id: '5', method: 'GET', path: '//evil' }));
    expect(out.at(-1)).toMatchObject({ id: '5', type: 'done', status: 404 });
  });

  it('cancels a running request', async () => {
    const handle = (req: Request) => new Promise<Response>((_, fail) => req.signal.addEventListener('abort', () => fail(Object.assign(new Error('x'), { name: 'AbortError' }))));
    const out: any[] = [];
    const link = makeLink(handle, (m) => out.push(m), 'https://x');
    void link.request(JSON.stringify({ id: 'a', method: 'GET', path: '/slow' }));
    await settle();
    link.abort('a');
    await settle();
    expect(out).toEqual([{ id: 'a', type: 'error', message: 'aborted' }]);
  });
});
