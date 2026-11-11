import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Icon } from './Icon';
import { Empty, Loading, Modal, useConfirm, useToast } from './ui';
import { api, del, patch, post } from '../lib/api';
import { useData } from '../lib/hooks';
import { fmtDateTime } from '../lib/format';
import { MOBILE } from '../lib/device';

/** The Windows app (desktop/) puts this on the page; it knows the PC's local network addresses. */
interface DesktopBridge { lanAddresses?: () => Promise<string[]>; isDesktop?: boolean }
const desktop = (): DesktopBridge | undefined => (globalThis as any).CarinoDesktop;

const TABLE: Record<string, string> = { tasks: 'To-do', notes: 'Note', memories: 'Memory', expenses: 'Spending', applications: 'Application', reminders: 'Reminder', conversations: 'Chat', messages: 'Message', bills: 'Bill', debts: 'Debt', income: 'Income', projects: 'Project', documents: 'File', savings_goals: 'Savings goal', handoffs: 'Handoff' };

/** Settings → Devices: pair the phone and the PC, compare the check number, sync, and settle conflicts. */
export function Devices() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, reload } = useData<any>('/sync');
  const [pairing, setPairing] = useState<'show' | 'join' | null>(null);
  const [checking, setChecking] = useState<{ id: string; name: string; check: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Syncs also run in the background (on opening the app, every minute): keep this screen current.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && reload(), 4000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <Loading rows={2} />;
  // The Windows app runs the phone build of Carino, so it says so itself.
  const isPc = !MOBILE || !!desktop()?.isDesktop;
  const run = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      reload();
      return r;
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const syncNow = () => run(async () => {
    const r = await post<any>('/sync/now', {});
    const bad = r.results.find((x: any) => x.error);
    if (bad) throw new Error(bad.error);
    const n = r.results.reduce((a: number, x: any) => a + x.sent + x.received, 0);
    toast(n ? `Synced ${n} change${n === 1 ? '' : 's'}${r.conflicts ? ` · ${r.conflicts} to check` : ''}` : 'Up to date');
  });
  return (
    <div className="stack">
      <p className="small muted">Pair your phone and your PC to keep to-dos, chats, money, applications and files in step, and to carry on where you left off. They talk directly over your Wi-Fi, encrypted with a key only the two devices have. Approvals and routines stay on the device where they were set up.</p>
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="small">This device: <b>{data.device.name}</b></span>
        <button className="linklike small" onClick={async () => { const n = prompt('Name this device', data.device.name); if (n?.trim()) await run(() => patch('/sync/device', { name: n.trim() })); }}>Rename</button>
      </div>
      {data.peers.length > 0 && (
        <ul className="list divided">
          {data.peers.map((p: any) => (
            <li key={p.device_id} className="list-item" style={{ flexWrap: 'wrap' }}>
              <Icon name={p.role === 'listener' ? 'code' : 'phone'} size={16} />
              <span className="grow">
                <b>{p.name}</b>
                <span className="tiny muted" style={{ display: 'block' }}>
                  {!p.confirmed ? 'Waiting for you to compare the check number' : p.last_error ? <span className="warn-text">{p.last_error}</span> : p.last_sync_at ? `Synced ${fmtDateTime(p.last_sync_at)}` : 'Not synced yet'}
                  {p.pending > 0 && p.confirmed ? ` · ${p.pending} change${p.pending === 1 ? '' : 's'} to send` : ''}
                </span>
              </span>
              {!p.confirmed && <button className="btn sm primary" onClick={async () => { const r = await api<any>(`/sync/peers/${p.device_id}/check`); setChecking({ id: p.device_id, name: p.name, check: r.check }); }}>Check number</button>}
              {p.confirmed && p.role === 'listener' && <button className="btn sm" disabled={busy} onClick={syncNow}><Icon name="refresh" size={14} />Sync now</button>}
              <button className="btn ghost sm" aria-label={`Forget ${p.name}`} onClick={async () => { if (await confirm({ title: `Forget ${p.name}?`, body: 'They stop syncing. Nothing already on either device is deleted.', confirm: 'Forget', danger: true })) await run(() => del(`/sync/peers/${p.device_id}`), 'Forgotten'); }}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        {isPc && <button className="btn primary" onClick={() => setPairing('show')}><Icon name="phone" size={14} />Pair a phone</button>}
        {!isPc && <button className="btn primary" onClick={() => setPairing('join')}><Icon name="link" size={14} />Pair with my PC</button>}
        {!isPc && <span className="tiny muted">Install Carino for Windows on your PC, open Settings → Devices there and choose “Pair a phone”.</span>}
      </div>
      {data.conflicts.length > 0 && <Conflicts conflicts={data.conflicts} onDone={reload} />}
      {pairing === 'show' && <ShowPairing onClose={() => { setPairing(null); reload(); }} />}
      {pairing === 'join' && <JoinPairing onClose={() => setPairing(null)} onJoined={(r) => { setPairing(null); setChecking({ id: r.peer, name: r.name, check: r.check }); reload(); }} />}
      {checking && (
        <Modal title="Do the numbers match?" onClose={() => setChecking(null)} footer={<>
          <button className="btn ghost" onClick={async () => { await run(() => del(`/sync/peers/${checking.id}`)); setChecking(null); }}>They don’t match</button>
          <button className="btn primary" onClick={async () => { await run(() => post(`/sync/peers/${checking.id}/confirm`, {}), 'Paired'); setChecking(null); }}>They match</button>
        </>}>
          <p className="small">Check that <b>{checking.name}</b> shows the same number:</p>
          <p className="check-number" aria-live="polite">{checking.check}</p>
          <p className="tiny muted">Confirm on both devices. If the numbers differ, something is between them: don’t pair.</p>
        </Modal>
      )}
    </div>
  );
}

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="qr" role="img" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** On the PC: a code and QR code for the phone, valid for 10 minutes; then the check number. */
function ShowPairing({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<any>(null);
  const [peers, setPeers] = useState<number | null>(null);
  useEffect(() => {
    (async () => {
      const addresses = (await desktop()?.lanAddresses?.().catch(() => [])) ?? [];
      const r = await post<any>('/sync/pair/start', { addresses });
      setP(r);
      setPeers((await api<any>('/sync')).peers.length);
    })().catch((e) => toast(e.message, 'error'));
  }, [toast]);
  // When the phone has answered, its entry appears: show the number to compare.
  useEffect(() => {
    if (!p) return;
    const t = setInterval(async () => {
      const s = await api<any>('/sync').catch(() => null);
      if (s && peers !== null && s.peers.length > peers) {
        clearInterval(t);
        onClose();
      }
    }, 1500);
    return () => clearInterval(t);
  }, [p, peers, onClose]);
  return (
    <Modal title="Pair a phone" onClose={onClose}>
      {!p ? <Loading /> : (
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <p className="small">On your phone, open Carino → Settings → Devices → <b>Pair with my PC</b>, and scan this:</p>
          <Qr text={p.link} />
          <p className="small">Or type the code <b className="mono">{p.code}</b>{p.offer.at?.[0] ? <> and the address <b className="mono">{p.offer.at[0]}</b></> : ''}.</p>
          {!p.offer.at?.length && <p className="tiny warn-text">This PC’s address isn’t known here. In the Windows app it’s filled in for you.</p>}
          <p className="tiny muted">The code works for 10 minutes. Afterwards, choose “Check number” next to the phone to compare.</p>
        </div>
      )}
    </Modal>
  );
}

/** On the phone: scan the PC's QR code (when the camera can read it here) or paste/type it. */
function JoinPairing({ onClose, onJoined }: { onClose: () => void; onJoined: (r: any) => void }) {
  const toast = useToast();
  const [link, setLink] = useState('');
  const [code, setCode] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const canScan = typeof (globalThis as any).BarcodeDetector === 'function' && !!navigator.mediaDevices?.getUserMedia;
  const join = async (body: any) => {
    setBusy(true);
    try {
      onJoined(await post<any>('/sync/pair/join', body));
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const scan = async () => {
    setScanning(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      await video.play();
      const detector = new (globalThis as any).BarcodeDetector({ formats: ['qr_code'] });
      for (let i = 0; i < 150; i++) {
        const found = await detector.detect(video).catch(() => []);
        const hit = found.find((f: any) => String(f.rawValue).startsWith('carino-pair:'));
        if (hit) {
          setLink(hit.rawValue);
          await join({ link: hit.rawValue });
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      toast('No Carino QR code seen. Paste the code instead.', 'error');
    } catch {
      toast('The camera isn’t available. Paste or type the code instead.', 'error');
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setScanning(false);
    }
  };
  return (
    <Modal title="Pair with my PC" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || (!link.trim() && !(code.trim() && address.trim()))} onClick={() => join(link.trim() ? { link: link.trim(), address: address.trim() || undefined } : { code, address })}>{busy ? 'Pairing…' : 'Pair'}</button>
    </>}>
      <div className="stack">
        <p className="small muted">On the PC, open Carino → Settings → Devices → <b>Pair a phone</b>. Both must be on the same Wi-Fi.</p>
        {canScan && <button className="btn" disabled={scanning || busy} onClick={scan}><Icon name="eye" size={14} />{scanning ? 'Looking for the code…' : 'Scan the QR code'}</button>}
        <div className="field"><label htmlFor="pl">Pairing link (from the QR code)</label><input id="pl" className="input mono" value={link} onChange={(e) => setLink(e.target.value)} placeholder="carino-pair:…" /></div>
        <p className="tiny muted" style={{ textAlign: 'center' }}>or</p>
        <div className="grid two">
          <div className="field"><label htmlFor="pc">Code</label><input id="pc" className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCDE-FGHJK" /></div>
          <div className="field"><label htmlFor="pa">PC address</label><input id="pa" className="input mono" inputMode="url" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://192.168.1.20:47900" /></div>
        </div>
      </div>
    </Modal>
  );
}

/** Records changed on both devices: shown side by side; the user chooses which to keep. */
function Conflicts({ conflicts, onDone }: { conflicts: any[]; onDone: () => void }) {
  const toast = useToast();
  const keep = async (id: string, which: 'mine' | 'theirs') => {
    try {
      await post(`/sync/conflicts/${id}`, { keep: which });
      toast(which === 'mine' ? 'Kept this device’s version; it goes to the other device on the next sync.' : 'Took the other device’s version.');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const label = (r: any) => (r ? String(r.title ?? r.name ?? r.content ?? r.note ?? r.label ?? r.source ?? r.amount ?? r.id) : '(deleted)');
  const fields = (a: any, b: any) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => !['id', 'created_at', 'updated_at'].includes(k) && JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
  if (!conflicts.length) return <Empty icon="check" title="Nothing to check" />;
  return (
    <section aria-label="Changes to check">
      <h3>Changed on both devices</h3>
      <p className="tiny muted">These were edited on both before they could sync. Nothing was overwritten: choose which to keep.</p>
      {conflicts.map((c) => (
        <div key={c.id} className="card pad conflict">
          <div className="tiny muted">{TABLE[c.tbl] ?? c.tbl} · with {c.peer_name ?? 'the other device'}</div>
          <div className="conflict-sides">
            <div><div className="tiny muted">This device</div><b>{label(c.mine)}</b>
              <ul className="tiny">{fields(c.mine, c.theirs).slice(0, 6).map((k) => <li key={k}>{k}: {String(c.mine?.[k] ?? '—').slice(0, 80)}</li>)}</ul></div>
            <div><div className="tiny muted">{c.peer_name ?? 'Other device'}</div><b>{label(c.theirs)}</b>
              <ul className="tiny">{fields(c.mine, c.theirs).slice(0, 6).map((k) => <li key={k}>{k}: {String(c.theirs?.[k] ?? '—').slice(0, 80)}</li>)}</ul></div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => keep(c.id, 'mine')}>Keep this device’s</button>
            <button className="btn sm" onClick={() => keep(c.id, 'theirs')}>Keep {c.peer_name ?? 'the other'}’s</button>
          </div>
        </div>
      ))}
    </section>
  );
}
