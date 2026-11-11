import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, Wordmark } from './Icon';
import { Link, navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { useOnline, useDebounced } from '../lib/hooks';
import { api } from '../lib/api';
import { Modal } from './ui';
import { resolveOp, setSyncUser, syncQueue, useSyncState } from '../lib/sync';

/** The four main places, as tabs on phones and the top of the sidebar on PCs. */
const PRIMARY = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/chat', label: 'Chats', icon: 'chat' },
  { to: '/discover', label: 'Discover', icon: 'sparkle' },
  { to: '/stuff', label: 'Your stuff', icon: 'archive' },
];
/** What "Your stuff" holds. */
const STUFF = [
  { to: '/tasks', label: 'To-dos & reminders', icon: 'tasks' },
  { to: '/money', label: 'Money', icon: 'wallet' },
  { to: '/routines', label: 'Routines', icon: 'clock' },
  { to: '/memory', label: 'Memory', icon: 'brain' },
];
const NAV = [...PRIMARY, ...STUFF];
const ME_PATHS = ['/me', '/settings', '/notifications', '/actions', '/messaging', '/connectors', '/apps'];

const isActive = (to: string, path: string) => (to === '/' ? path === '/' : path === to || path.startsWith(to + '/'));
const tabActive = (to: string, path: string) =>
  to === '/stuff' ? isActive('/stuff', path) || STUFF.some((s) => isActive(s.to, path))
  : to === '/me' ? ME_PATHS.some((p) => isActive(p, path))
  : isActive(to, path);

export function Shell({ title, actions, children, bare }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; bare?: boolean }) {
  const { pathname } = useLocation();
  const { me, counts, logout, offlineSession } = useSession();
  const online = useOnline();
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const update = useSwUpdate();

  useEffect(() => setMenu(false), [pathname]);
  // Android: notice the on-screen keyboard so the tab bar can step aside for the composer.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => document.documentElement.classList.toggle('kb-open', window.innerHeight - vv.height > 150 || (screen.height - vv.height > 260 && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')));
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!me?.user.id) return;
    setSyncUser(me.user.id);
    if (online) void syncQueue();
  }, [me?.user.id, online]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        navigate(NAV[Number(e.key) - 1].to);
      } else if (!typing && e.key === '/' && !e.ctrlKey && !e.metaKey) {
        const composer = document.querySelector<HTMLElement>('[data-composer]');
        if (composer) {
          e.preventDefault();
          composer.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="shell">
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand"><Link to="/" aria-label="Carino home"><Wordmark /></Link></div>
        <button className="nav-item" onClick={() => setPalette(true)} style={{ border: '1px solid var(--border)', marginBottom: 8, background: 'var(--surface)' }}>
          <Icon name="search" /> <span className="grow">Search</span> <span className="kbd desktop-only">Ctrl K</span>
        </button>
        <Link to="/chat/new" className="nav-item" style={{ color: 'var(--brand-text)' }}><Icon name="plus" />New chat</Link>
        {PRIMARY.map((n) => (
          <Link key={n.to} to={n.to} className={`nav-item ${isActive(n.to, pathname) ? 'active' : ''}`} aria-current={isActive(n.to, pathname) ? 'page' : undefined}>
            <Icon name={n.icon} /> {n.label}
          </Link>
        ))}
        <div className="nav-section">Your stuff</div>
        {STUFF.map((n) => (
          <Link key={n.to} to={n.to} className={`nav-item ${isActive(n.to, pathname) ? 'active' : ''}`} aria-current={isActive(n.to, pathname) ? 'page' : undefined}>
            <Icon name={n.icon} /> {n.label}
          </Link>
        ))}
        <div className="nav-section">You</div>
        <Link to="/actions" className={`nav-item ${isActive('/actions', pathname) ? 'active' : ''}`}>
          <Icon name="shield" /> Approvals
          {counts.pendingActions > 0 && <span className="count" aria-label={`${counts.pendingActions} waiting`}>{counts.pendingActions}</span>}
        </Link>
        <Link to="/notifications" className={`nav-item ${isActive('/notifications', pathname) ? 'active' : ''}`}>
          <Icon name="bell" /> Notifications
          {counts.unread > 0 && <span className="count">{counts.unread}</span>}
        </Link>
        <Link to="/messaging" className={`nav-item ${isActive('/messaging', pathname) ? 'active' : ''}`}><Icon name="send" /> Messaging</Link>
        <Link to="/apps" className={`nav-item ${isActive('/apps', pathname) || isActive('/connectors', pathname) ? 'active' : ''}`}><Icon name="link" /> My apps</Link>
        <Link to="/settings" className={`nav-item ${isActive('/settings', pathname) ? 'active' : ''}`}><Icon name="settings" /> Settings</Link>
        <div className="sidebar-footer">
          <div className="row" style={{ padding: '6px 8px' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600, fontSize: '0.9em' }}>{me?.settings.profile.displayName || me?.user.name}</div>
              <div className="ellipsis faint tiny">{me?.user.email}</div>
            </div>
            <button className="btn ghost icon sm" onClick={() => void logout()} aria-label="Sign out" title="Sign out"><Icon name="logout" size={16} /></button>
          </div>
        </div>
      </aside>

      <div className="main" role="main">
        {(!online || offlineSession) && (
          <div className="banner offline" role="status"><Icon name="wifiOff" size={16} /> You’re offline. To-dos, reminders and chats you opened before are available. New tasks and edits to tasks and notes are kept on this device and sync when you reconnect; AI, research and reminders need a connection.</div>
        )}
        <SyncStatus />
        {update.available && (
          <div className="banner update" role="status">A new version of Carino is ready. <button className="btn sm primary" onClick={update.apply}>Update</button></div>
        )}
        {!bare && (
          <header className="topbar">
            <button className="btn ghost icon mobile-only" onClick={() => setMenu(true)} aria-label="Open menu"><Icon name="menu" /></button>
            <h1 className="grow ellipsis">{title}</h1>
            {actions}
            <button className="btn ghost icon mobile-only" onClick={() => setPalette(true)} aria-label="Search"><Icon name="search" /></button>
          </header>
        )}
        {children}
      </div>

      <nav className="bottom-nav" aria-label="Main sections">
        {[...PRIMARY, { to: '/me', label: 'Me', icon: 'user' }].map((n) => {
          const on = tabActive(n.to, pathname);
          return (
            <Link key={n.to} to={n.to} className={on ? 'active' : ''} aria-current={on ? 'page' : undefined}>
              <span className="tab-ic"><Icon name={n.icon} size={21} /></span>{n.label}
              {n.to === '/me' && counts.pendingActions + counts.unread > 0 && <span className="dot" aria-label="Something needs you" />}
            </Link>
          );
        })}
      </nav>

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [results, setResults] = useState<any[]>([]);
  const debounced = useDebounced(q, 200);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = [
    { label: 'New chat', icon: 'chat', go: '/chat/new' },
    { label: 'Add a to-do', icon: 'plus', go: '/tasks?new=1' },
    { label: 'Ramble it out (brain-dump into to-dos)', icon: 'mic', go: '/ramble' },
    { label: 'New routine', icon: 'clock', go: '/routines' },
    { label: 'Log spending', icon: 'wallet', go: '/money' },
    { label: 'Connect an app (Gmail, Outlook, Instagram…)', icon: 'link', go: '/apps' },
    ...NAV.map((n) => ({ label: `Go to ${n.label}`, icon: n.icon, go: n.to })),
    { label: 'Approvals', icon: 'shield', go: '/actions' },
    { label: 'Settings', icon: 'settings', go: '/settings' },
  ].filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    if (debounced.trim().length < 2) {
      setResults([]);
      return;
    }
    api(`/search?q=${encodeURIComponent(debounced)}`).then((d) => setResults(d.results)).catch(() => setResults([]));
  }, [debounced]);

  const hrefFor = (r: any) => ({
    task: `/tasks?focus=${r.id}`,
    memory: '/memory', conversation: `/chat/${r.id}`,
  } as Record<string, string>)[r.entity] ?? '/';
  const items = [...commands.map((c) => ({ kind: 'cmd', ...c })), ...results.map((r) => ({ kind: 'hit', label: r.title, snippet: r.snippet, icon: ({ note: 'note', document: 'file', task: 'tasks', project: 'folder', memory: 'brain', conversation: 'chat' } as any)[r.entity] ?? 'search', go: hrefFor(r), entity: r.entity }))];

  const go = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    navigate(it.go);
  };

  return (
    <Modal onClose={onClose} labelledBy="palette-label">
      <div className="palette" style={{ margin: '-10px -20px' }}>
        <label id="palette-label" className="sr-only" htmlFor="palette-input">Search Carino</label>
        <input
          id="palette-input" ref={inputRef} className="input" autoFocus placeholder="Search to-dos, memories, chats… or type a command"
          value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') go(sel);
          }}
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={`pal-${sel}`}
        />
        <div className="palette-results" id="palette-list" role="listbox">
          {items.map((it: any, i) => (
            <div key={i} id={`pal-${i}`} role="option" aria-selected={i === sel} className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
              <Icon name={it.icon} size={16} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{it.label}</div>
                {it.snippet && <div className="faint tiny ellipsis">{it.snippet.replace(/[[\]]/g, '')}</div>}
              </div>
              {it.entity && <span className="badge">{it.entity}</span>}
            </div>
          ))}
          {q.length >= 2 && !results.length && <div className="faint small" style={{ padding: 12 }}>No saved items match “{q}”.</div>}
        </div>
      </div>
    </Modal>
  );
}

/** Detects a waiting service worker and lets the user switch to the new version. */
function useSwUpdate() {
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null);
  useEffect(() => {
    // The phone app has no service worker (its files are on the phone).
    if (import.meta.env.VITE_MOBILE || !('serviceWorker' in navigator)) return;
    const check = (r?: ServiceWorkerRegistration) => {
      if (r?.waiting && navigator.serviceWorker.controller) setReg(r);
    };
    let registration: ServiceWorkerRegistration | undefined;
    const onUpdate = () => registration?.installing?.addEventListener('statechange', () => check(registration));
    navigator.serviceWorker.getRegistration().then((r) => {
      if (!r) return;
      registration = r;
      check(r);
      r.addEventListener('updatefound', onUpdate);
    });
    let reloaded = false;
    const onControllerChange = () => {
      if (!reloaded) {
        reloaded = true;
        location.reload();
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    // Every screen mounts its own Shell, so remove these again or they pile up one per page.
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      registration?.removeEventListener('updatefound', onUpdate);
    };
  }, []);
  return { available: !!reg, apply: () => reg?.waiting?.postMessage({ type: 'SKIP_WAITING' }) };
}

/** Shows queued offline changes and lets the user resolve conflicts the server reported. */
function SyncStatus() {
  const s = useSyncState();
  const [open, setOpen] = useState(false);
  const problems = [...s.conflicts, ...s.failed];
  if (!s.pending && !problems.length) return null;
  return (
    <>
      <div className={`banner ${problems.length ? 'offline' : 'update'}`} role="status">
        <Icon name={problems.length ? 'alert' : 'refresh'} size={16} />
        {s.pending > 0 && <span>{s.syncing ? 'Syncing' : 'Waiting to sync'} {s.pending} change{s.pending === 1 ? '' : 's'} made offline.</span>}
        {problems.length > 0 && (
          <>
            <span>{problems.length} change{problems.length === 1 ? '' : 's'} could not be synced.</span>
            <button className="btn sm" onClick={() => setOpen(true)}>Review</button>
          </>
        )}
      </div>
      {open && (
        <Modal title="Offline changes to review" onClose={() => setOpen(false)}>
          <ul className="list">
            {problems.map((op) => (
              <li key={op.id} style={{ padding: '8px 0' }}>
                <div><strong>{op.label}</strong></div>
                <div className="small muted">{op.status === 'conflict' ? 'This item was changed elsewhere after you edited it offline.' : op.error}</div>
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn sm" onClick={() => void resolveOp(op, 'discard')}>Discard my change</button>
                  {op.status === 'conflict' && <button className="btn sm primary" onClick={() => void resolveOp(op, 'overwrite')}>Keep my change</button>}
                </div>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}
