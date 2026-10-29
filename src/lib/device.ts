import { useEffect, useState } from 'react';
import { saveFile } from '../../mobile/native';

/** True in the Android app, where Carino's server runs on the phone itself (mobile/engine.ts). */
export const MOBILE = !!import.meta.env.VITE_MOBILE;

/**
 * An image or file from the API as an object URL. In the phone app API calls are answered
 * in-process, so <img src="/api/…"> can't load them directly; the web app uses the path as is.
 */
export function useApiUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(MOBILE ? null : path);
  useEffect(() => {
    if (!MOBILE || !path) return setUrl(path);
    let made: string | null = null;
    let live = true;
    fetch(path).then((r) => (r.ok ? r.blob() : null)).then((b) => {
      if (b && live) setUrl((made = URL.createObjectURL(b)));
    }).catch(() => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return url;
}

/** Saves a file from the API to the phone's Downloads folder. Returns a message to show. */
export async function downloadApi(path: string, fallbackName = 'download') {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const disp = res.headers.get('content-disposition') ?? '';
  const name = decodeURIComponent(disp.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? disp.match(/filename="?([^";]+)"?/i)?.[1] ?? fallbackName);
  return saveFile(await res.blob(), name);
}
