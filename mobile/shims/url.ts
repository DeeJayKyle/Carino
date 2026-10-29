export const fileURLToPath = (u: string | URL) => {
  const s = String(u);
  return s.startsWith('file://') ? decodeURIComponent(new URL(s).pathname) : '/app/server/x.js';
};
export const pathToFileURL = (p: string) => new URL(`file://${p}`);
const WebURL = globalThis.URL;
const WebURLSearchParams = globalThis.URLSearchParams;
export { WebURL as URL, WebURLSearchParams as URLSearchParams };
export default { fileURLToPath, pathToFileURL, URL: WebURL, URLSearchParams: WebURLSearchParams };
