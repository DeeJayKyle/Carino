import { useEffect, useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { Empty, Loading, fmtBytes, useToast } from '../components/ui';
import { post, upload } from '../lib/api';
import { navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';

/** Must match the cache the service worker writes shared items to (src/sw.ts). */
const SHARE_CACHE = 'carino-share';

type Shared = { title: string; text: string; url: string; files: { index: number; name: string; type: string; size: number }[] };

async function readShare(id: string): Promise<{ meta: Shared; files: File[] } | null> {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const res = await cache.match(`/share-data/${id}/meta`);
  if (!res) return null;
  const meta = (await res.json()) as Shared;
  const files: File[] = [];
  for (const f of meta.files) {
    const r = await cache.match(`/share-data/${id}/file/${f.index}`);
    if (r) files.push(new File([await r.blob()], f.name, { type: f.type }));
  }
  return { meta, files };
}

async function clearShare(id: string) {
  const cache = await caches.open(SHARE_CACHE);
  for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith(`/share-data/${id}/`)) await cache.delete(req);
}

/** The shared URL often arrives inside `text` (Android puts it there), so pull it out. */
function splitShare(meta: Shared) {
  const found = meta.url || meta.text.match(/https?:\/\/\S+/)?.[0] || '';
  const text = meta.text.replace(found, '').trim();
  return { title: meta.title.trim(), text, url: found };
}

export default function Share() {
  const toast = useToast();
  const { query } = useLocation();
  const { me } = useSession();
  const id = query.get('id');
  const err = query.get('error');
  const [data, setData] = useState<{ meta: Shared; files: File[] } | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const ai = me!.server.providers.some((p) => p.configured);

  useEffect(() => {
    if (!id) {
      setData(null);
      return;
    }
    readShare(id).then(setData).catch(() => setData(null));
  }, [id]);

  if (err || data === null) {
    return (
      <Shell title="Share to Carino"><div className="page">
        <Empty icon="info" title={err === 'no-sw' ? 'Open Carino once, then share again' : 'Nothing to show'}>
          {err === 'no-sw'
            ? 'Sharing works after Carino has been opened at least once on this device (it sets itself up for offline use). It’s ready now — go back to the other app and share again.'
            : 'This shared item is no longer available. Share it again from the other app.'}
        </Empty>
      </div></Shell>
    );
  }
  if (data === undefined) return <Shell title="Share to Carino"><div className="page"><Loading /></div></Shell>;

  const { title, text, url } = splitShare(data.meta);
  const files = data.files;
  const summaryLine = [title, text, url].filter(Boolean).join('\n');

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
      await clearShare(id!);
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(null);
    }
  };
  const uploadAll = async () => {
    const ids: string[] = [];
    for (const f of files) ids.push((await upload(f)).document.id);
    return ids;
  };

  const askCarino = () => run('ask', async () => {
    const attachments = await uploadAll();
    const conv = await post('/conversations', { title: title || url || files[0]?.name || 'Shared with Carino' });
    const prompt = [
      summaryLine && `I shared this with you:\n${summaryLine}`,
      files.length ? `I attached ${files.length === 1 ? 'a file' : `${files.length} files`}.` : '',
      url ? 'Read the page if you can, and tell me what matters in it.' : 'Tell me what matters in it.',
    ].filter(Boolean).join('\n\n');
    sessionStorage.setItem(`carino:first:${conv.id}`, JSON.stringify({ text: prompt, attachments }));
    navigate(`/chat/${conv.id}`, { replace: true });
  });
  const remember = () => run('memory', async () => {
    const content = [title, text, url && `(${url})`].filter(Boolean).join(' — ').replace(/\s+/g, ' ').slice(0, 1900);
    await post('/memories', { content });
    toast('Carino will remember this');
    navigate('/memory', { replace: true });
  });
  const addTask = () => run('task', async () => {
    await post('/tasks', { title: (title || text.split('\n')[0] || url).slice(0, 300), description: [text, url].filter(Boolean).join('\n\n') || undefined, tags: ['shared'] });
    toast('Added to your to-dos');
    navigate('/tasks', { replace: true });
  });
  return (
    <Shell title="Share to Carino">
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="page-head"><div><h1>Shared with Carino</h1><p className="sub">Choose what to do with it. Nothing has been sent to Carino’s server yet.</p></div></div>
        <section className="card pad stack">
          {title && <div style={{ fontWeight: 600 }}>{title}</div>}
          {text && <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>}
          {url && <p className="small ellipsis"><Icon name="link" size={14} /> <a href={url} target="_blank" rel="noopener noreferrer">{url}</a></p>}
          {files.length > 0 && (
            <ul className="list">
              {files.map((f) => (
                <li key={f.name} className="list-item"><Icon name={f.type.startsWith('image/') ? 'eye' : 'file'} size={16} /><span className="grow ellipsis">{f.name}</span><span className="faint small">{fmtBytes(f.size)}</span></li>
              ))}
            </ul>
          )}
          {!title && !text && !url && !files.length && <p className="muted">The other app didn’t share any content.</p>}
        </section>
        <div className="quick" style={{ marginTop: 16 }}>
          <button onClick={askCarino} disabled={!!busy || !ai} title={ai ? undefined : 'Connect an AI provider first'}><span className="qi"><Icon name="chat" /></span>{busy === 'ask' ? 'Opening…' : 'Ask Carino about it'}</button>
          {(title || text || url) && <button onClick={remember} disabled={!!busy}><span className="qi"><Icon name="brain" /></span>{busy === 'memory' ? 'Saving…' : 'Remember this'}</button>}
          {(title || text || url) && <button onClick={addTask} disabled={!!busy}><span className="qi"><Icon name="plus" /></span>{busy === 'task' ? 'Adding…' : 'Add as a to-do'}</button>}
        </div>
      </div>
    </Shell>
  );
}
