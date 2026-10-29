import { Component, lazy, Suspense, type ReactNode } from 'react';
import { SessionProvider, useSession } from './lib/session';
import { ToastProvider, ConfirmProvider, Spinner } from './components/ui';
import { match, useLocation, useSwNavigation } from './lib/router';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { MobileBridge } from './components/MobileBridge';
import { MOBILE } from './lib/device';

const Chat = lazy(() => import('./pages/Chat'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Memory = lazy(() => import('./pages/Memory'));
const Actions = lazy(() => import('./pages/Actions'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Settings = lazy(() => import('./pages/Settings'));
const Routines = lazy(() => import('./pages/Routines'));
const Ramble = lazy(() => import('./pages/Ramble'));
const Share = lazy(() => import('./pages/Share'));
const Connectors = lazy(() => import('./pages/Connectors'));
const Apps = lazy(() => import('./pages/Apps'));
const Messaging = lazy(() => import('./pages/Messaging'));
const Discover = lazy(() => import('./pages/Discover'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Stuff = lazy(() => import('./pages/Stuff'));
const Me = lazy(() => import('./pages/Me'));

function Router() {
  const { pathname } = useLocation();
  const { me, loading } = useSession();
  useSwNavigation();
  if (loading) return <Centered><Spinner lg /></Centered>;
  if (!me) return <Login />;
  // First run: a short setup. Shared items and sign-in returns are never interrupted by it.
  if (!me.settings.onboarded && !pathname.startsWith('/share') && !pathname.startsWith('/connectors') && !pathname.startsWith('/apps')) {
    return <Suspense fallback={<Centered><Spinner lg /></Centered>}><Onboarding /></Suspense>;
  }

  const routes: [string, (p: Record<string, string>) => ReactNode][] = [
    ['/', () => <Home />],
    ['/chat', () => <Chat />],
    ['/chat/:id', (p) => <Chat id={p.id} />],
    ['/tasks', () => <Tasks />],
    ['/memory', () => <Memory />],
    ['/actions', () => <Actions />],
    ['/notifications', () => <Notifications />],
    ['/settings', () => <Settings />],
    ['/routines', () => <Routines />],
    ['/ramble', () => <Ramble />],
    ['/share', () => <Share />],
    ['/connectors', () => <Connectors />],
    ['/apps', () => <Apps />],
    ['/apps/:id', (p) => <Apps id={p.id} />],
    ['/messaging', () => <Messaging />],
    ['/discover', () => <Discover />],
    ['/stuff', () => <Stuff />],
    ['/me', () => <Me />],
  ];
  for (const [pattern, render] of routes) {
    const params = match(pattern, pathname);
    if (params) return <PageBoundary key={pathname}><Suspense fallback={<Centered><Spinner lg /></Centered>}>{render(params)}</Suspense></PageBoundary>;
  }
  return <Home />;
}

const Centered = ({ children }: { children: ReactNode }) => <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>{children}</div>;

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider>
          {MOBILE && <MobileBridge />}
          <Router />
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

/**
 * If a screen can't load (for example its code couldn't be fetched while offline in the web
 * version), say so and offer a retry instead of leaving a blank page.
 */
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn('[page]', err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Centered>
        <div className="empty" role="alert">
          <h3>This screen couldn’t open</h3>
          <p>Check your connection, then try again. Your data is safe.</p>
          <button className="btn primary" onClick={() => location.reload()}>Try again</button>
        </div>
      </Centered>
    );
  }
}
