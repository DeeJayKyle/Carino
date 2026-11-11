import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useConfirm, useToast } from './ui';
import { useData } from '../lib/hooks';
import { del } from '../lib/api';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { forgetFolder } from '../../mobile/native';

interface DesktopApps { listApps?: () => Promise<{ id: string; name: string; path?: string }[]>; pickApp?: () => Promise<{ id: string; name: string } | null>; forgetApp?: (id: string) => Promise<void> }
const desktop = (): DesktopApps | undefined => (globalThis as any).CarinoDesktop;

/**
 * Everything Carino can reach, in one place, each with a way to take it back: folders, apps on this
 * PC, signed-in accounts, connected tools, paired devices and messaging channels, plus where chat
 * content goes to be answered.
 */
export function AccessOverview() {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = useSession();
  const files = useData<any>('/files');
  const apps = useData<any>('/apps');
  const connectors = useData<any>('/connectors');
  const sync = useData<any>('/sync');
  const channels = useData<any>('/channels');

  const revoke = async (what: string, body: string, fn: () => Promise<unknown>, reload: () => void) => {
    if (!(await confirm({ title: `Remove ${what}?`, body, confirm: 'Remove' }))) return;
    try {
      await fn();
      toast(`Removed ${what}`);
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const providers = me!.server.providers;
  const ai = providers.find((p) => p.id === me!.settings.ai.provider && p.configured) ?? providers.find((p) => p.configured);
  const accounts = (apps.data?.apps ?? []).flatMap((p: any) => p.accounts.map((a: any) => ({ ...a, provider: p.label })));

  return (
    <div className="stack access-overview">
      <Group icon={ai?.capabilities.local ? 'lock' : 'globe'} title="Who answers your chats" empty="No AI service set up yet." items={ai ? [
        <Item key="ai" name={ai.label} detail={ai.capabilities.local ? 'Runs on this device: your messages stay here.' : 'Online: your messages, plus the memories and file text needed to answer, are sent to it.'}>
          <Link className="btn ghost sm" to="/settings#ai">Change</Link>
        </Item>,
      ] : []} />

      <Group icon="folder" title="Folders" more={<Link to="/files">Files</Link>} empty="No folders shared." items={(files.data?.folders ?? []).map((f: any) => (
        <Item key={f.id} name={f.label} detail={f.can_change ? 'Can read · can change with your OK' : 'Read only'}>
          <RemoveBtn label={f.label} onClick={() => revoke(f.label, 'Carino stops reading it and forgets what it noted. Your files aren’t touched.', async () => { await del(`/files/folders/${f.id}`); forgetFolder(f.root); }, files.reload)} />
        </Item>
      ))} />

      {desktop()?.listApps && <PcApps />}

      <Group icon="user" title="Signed-in accounts" more={<Link to="/apps">Apps</Link>} empty="No accounts connected." items={accounts.map((a: any) => (
        <Item key={a.id} name={`${a.provider}: ${a.label}`} detail={a.last_error ? `Problem: ${a.last_error}` : 'Reads with your OK per app settings; sending and posting always ask first.'}>
          <RemoveBtn label={a.label} onClick={() => revoke(`${a.provider} (${a.label})`, 'Carino signs out of this account and deletes its saved sign-in.', () => del(`/apps/accounts/${a.id}`), apps.reload)} />
        </Item>
      ))} />

      <Group icon="link" title="Connected tools" more={<Link to="/connectors">Connectors</Link>} empty="No connected tools." items={(connectors.data?.connectors ?? []).map((c: any) => (
        <Item key={c.id} name={c.name} detail={`${hostOf(c.url)} · ${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}${c.enabled ? '' : ' · switched off'}`}>
          <RemoveBtn label={c.name} onClick={() => revoke(c.name, 'Carino disconnects it and forgets its saved sign-in.', () => del(`/connectors/${c.id}`), connectors.reload)} />
        </Item>
      ))} />

      <Group icon="phone" title="Paired devices" more={<Link to="/settings#devices">Devices</Link>} empty="No paired devices." items={(sync.data?.peers ?? []).map((p: any) => (
        <Item key={p.device_id} name={p.name} detail={p.confirmed ? 'Keeps your data in step over your Wi-Fi' : 'Waiting for the check number'}>
          <RemoveBtn label={p.name} onClick={() => revoke(p.name, 'They stop syncing. Nothing already on either device is deleted.', () => del(`/sync/peers/${p.device_id}`), sync.reload)} />
        </Item>
      ))} />

      <Group icon="chat" title="Messaging" more={<Link to="/messaging">Messaging</Link>} empty="No messaging channels." items={(channels.data?.channels ?? []).map((ch: any) => (
        <Item key={ch.id} name={ch.kind === 'whatsapp' ? 'WhatsApp' : ch.kind === 'telegram' ? 'Telegram' : ch.kind} detail={`${ch.chats.length} chat${ch.chats.length === 1 ? '' : 's'} can talk to Carino`}>
          <RemoveBtn label={ch.kind} onClick={() => revoke(ch.kind === 'whatsapp' ? 'WhatsApp' : 'Telegram', 'Carino stops answering there.', () => del(`/channels/${ch.id}`), channels.reload)} />
        </Item>
      ))} />
    </div>
  );
}

/** Windows app: the programs the user approved for Carino to open (nothing else can be started). */
function PcApps() {
  const toast = useToast();
  const [list, setList] = useState<{ id: string; name: string; path?: string }[] | null>(null);
  const load = () => desktop()!.listApps!().then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const add = async () => {
    try {
      const a = await desktop()!.pickApp!();
      if (a) toast(`${a.name} can now be opened by Carino`);
      load();
    } catch (e: any) {
      toast(String(e?.message ?? e), 'error');
    }
  };
  return (
    <Group icon="briefcase" title="Apps on this PC" more={<button className="btn ghost sm" onClick={add}><Icon name="plus" size={14} />Add an app</button>}
      empty="None. Add an app (like Excel) so Carino can open it for you, with a file if you like. It can’t control apps once they’re open."
      items={(list ?? []).map((a) => (
        <Item key={a.id} name={a.name} detail="Can be opened by Carino">
          <RemoveBtn label={a.name} onClick={async () => { await desktop()!.forgetApp!(a.id); toast(`Removed ${a.name}`); load(); }} />
        </Item>
      ))} />
  );
}

function Group({ icon, title, more, items, empty }: { icon: string; title: string; more?: ReactNode; items: ReactNode[]; empty: string }) {
  return (
    <section className="access-group" aria-label={title}>
      <div className="row"><Icon name={icon} size={16} /><h3 className="grow" style={{ margin: 0 }}>{title}</h3>{more}</div>
      {items.length ? <ul className="list divided" style={{ marginTop: 6 }}>{items}</ul> : <p className="small muted" style={{ marginTop: 6 }}>{empty}</p>}
    </section>
  );
}

function Item({ name, detail, children }: { name: string; detail: string; children?: ReactNode }) {
  return (
    <li className="list-item">
      <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{name}</b><span className="tiny muted">{detail}</span></span>
      {children}
    </li>
  );
}

function RemoveBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return <button className="btn ghost sm" aria-label={`Remove ${label}`} onClick={onClick}><Icon name="x" size={14} />Remove</button>;
}

function hostOf(url: string) {
  try { return new URL(url).host; } catch { return url; }
}
