import type { Services } from '../context.ts';
import { checkConnectorUrl, McpError } from './mcp.ts';
import { htmlToText } from './apps/common.ts';

/**
 * Reads a public web page as text, for the assistant to extract information from. Only public
 * addresses (never the user's home network or this device), every redirect checked again, size and
 * time limited. The text is untrusted: the assistant treats it as information, never instructions.
 */
export class PageError extends Error {}

const MAX_BYTES = 3 * 1024 * 1024;

export async function capturePage(services: Services, raw: string) {
  const f = services.netFetch ?? fetch;
  let url: URL;
  try {
    url = await checkConnectorUrl(raw, false);
  } catch (e) {
    throw new PageError(e instanceof McpError ? e.message.replace(/connectors?/g, 'pages').replace(/ To allow.*$/, '') : 'That address can’t be read.');
  }
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    res = await f(url.href, { redirect: 'manual', headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', 'user-agent': 'Mozilla/5.0 (compatible; Carino)' }, signal: AbortSignal.timeout(20_000) })
      .catch(() => { throw new PageError(`Couldn’t reach ${url.hostname}.`); });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try {
        url = await checkConnectorUrl(new URL(res.headers.get('location')!, url).href, false);
      } catch {
        throw new PageError('The page redirected somewhere Carino won’t go (a private address).');
      }
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw new PageError(`${url.hostname} answered with error ${res?.status ?? '?'}.`);
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new PageError('That address isn’t a web page (it may be a file to download).');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new PageError('That page is too large to read.');
  const html = new TextDecoder().decode(buf);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  // Form fields on the page, so the assistant can help fill them (it never submits anything).
  const fields = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)].map((m) => {
    const attr = (n: string) => m[2].match(new RegExp(`${n}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? '';
    return { tag: m[1].toLowerCase(), name: attr('name'), type: attr('type') || m[1].toLowerCase(), label: attr('aria-label') || attr('placeholder') || attr('name') };
  }).filter((x) => x.name && !/^(hidden|submit|button|password|csrf)/i.test(x.type) && !/csrf|token/i.test(x.name)).slice(0, 60);
  const text = type.includes('html') ? htmlToText(html) : html;
  return { url: url.href, title, text: text.slice(0, 40_000), cut: text.length > 40_000, form_fields: fields };
}
