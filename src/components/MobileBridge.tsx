import { useEffect } from 'react';
import { navigate } from '../lib/router';
import { downloadApi } from '../lib/device';
import { post } from '../lib/api';
import { openExternal, takeShared } from '../../mobile/native';
import { useToast } from './ui';

/** Must match src/pages/Share.tsx, which reads shared items from this cache. */
const SHARE_CACHE = 'carino-share';

/** Hands what another app shared to the Share page, the same way the web app's service worker does. */
async function openShared() {
  const item = takeShared();
  if (!item) return;
  const id = crypto.randomUUID();
  const cache = await caches.open(SHARE_CACHE);
  const files = item.files.map((f, i) => ({ index: i, name: f.name || `shared-${i + 1}`, type: f.type, bytes: Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)) }));
  const meta = { title: item.title, text: item.text, url: item.url, files: files.map(({ index, name, type, bytes }) => ({ index, name, type, size: bytes.length })) };
  await cache.put(`/share-data/${id}/meta`, new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  await Promise.all(files.map((f) => cache.put(`/share-data/${id}/file/${f.index}`, new Response(f.bytes, { headers: { 'content-type': f.type || 'application/octet-stream' } }))));
  navigate(`/share?id=${id}`);
  // Inside the Flutter app: bring this web screen forward.
  (window as any).CarinoFlutter?.post(JSON.stringify({ type: 'show' }));
}

/** Phone app glue: notification taps, the Share menu, and links that can't open inside the app. */
export function MobileBridge() {
  const toast = useToast();
  useEffect(() => {
    const onOpen = (e: Event) => navigate((e as CustomEvent<string>).detail || '/');
    const onShared = () => void openShared().catch(() => toast('Could not open what was shared.', 'error'));
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented) return;
      const url = new URL(a.href, location.href);
      if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ics/'))) {
        e.preventDefault();
        downloadApi(url.pathname + url.search).then((m) => toast(m), (err) => toast(err.message, 'error'));
      } else if (url.origin !== location.origin && /^(https?|mailto|tel):/.test(url.protocol)) {
        e.preventDefault();
        openExternal(url.href);
      }
    };
    // A sign-in (My apps or a connected app) came back from the browser.
    const onOAuth = (e: Event) => {
      const q = Object.fromEntries(new URLSearchParams((e as CustomEvent<string>).detail || ''));
      post<{ kind: 'app' | 'connector'; label: string }>('/oauth/finish', q).then(
        (r) => {
          toast(`Connected ${r.label}`);
          navigate(r.kind === 'app' ? '/apps' : '/connectors');
          window.dispatchEvent(new Event('carino-apps-changed'));
        },
        (err) => toast(err.message, 'error'),
      );
    };
    window.addEventListener('carino-oauth', onOAuth);
    window.addEventListener('carino-open', onOpen);
    window.addEventListener('carino-shared', onShared);
    document.addEventListener('click', onClick);
    onShared();
    return () => {
      window.removeEventListener('carino-oauth', onOAuth);
      window.removeEventListener('carino-open', onOpen);
      window.removeEventListener('carino-shared', onShared);
      document.removeEventListener('click', onClick);
    };
  }, [toast]);
  return null;
}
