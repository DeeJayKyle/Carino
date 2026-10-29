import type { ImgHTMLAttributes, ReactNode } from 'react';
import { MOBILE, downloadApi, useApiUrl } from '../lib/device';
import { useToast } from './ui';

/** <img> for an /api/… image; works in the web app and the phone app. */
export function ApiImg({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const url = useApiUrl(src);
  return url ? <img src={url} {...rest} /> : <span className={`${rest.className ?? ''} img-loading`} aria-hidden="true" />;
}

/** A download link for an /api/… file. The phone app saves it to Downloads. */
export function ApiDownload({ href, name, className, children }: { href: string; name?: string; className?: string; children: ReactNode }) {
  const toast = useToast();
  if (!MOBILE) return <a className={className} href={href} download>{children}</a>;
  return (
    <button type="button" className={className} onClick={() => downloadApi(href, name).then((m) => toast(m), (e) => toast(e.message, 'error'))}>{children}</button>
  );
}
