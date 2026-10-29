// The app can't resolve names itself. Ordinary names count as public; local-only names count as
// private, so connector checks still refuse obvious on-device and home-network addresses.
export async function lookup(host: string, opts?: { all?: boolean }) {
  const h = host.toLowerCase();
  const local = h === 'localhost' || /\.(localhost|local|lan|home|internal)$/.test(h) || !h.includes('.');
  const rec = { address: local ? '127.0.0.1' : '93.184.215.14', family: 4 };
  return opts?.all ? [rec] : rec;
}
export default { lookup };
