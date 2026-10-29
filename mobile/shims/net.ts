const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function isIP(s: string) {
  if (V4.test(s)) return 4;
  if (s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s)) return 6;
  return 0;
}
export const isIPv4 = (s: string) => isIP(s) === 4;
export const isIPv6 = (s: string) => isIP(s) === 6;
export default { isIP, isIPv4, isIPv6 };
