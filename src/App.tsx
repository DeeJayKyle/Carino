import { lazy, Suspense, type ReactNode } from 'react';
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
  if (!me.settings.onboarded && !pathname.startsWith('/share') && !pathname.startsWith('/connectors')) {
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
    ['/messaging', () => <Messaging />],
    ['/discover', () => <Discover />],
    ['/stuff', () => <Stuff />],
    ['/me', () => <Me />],
  ];
  for (const [pattern, render] of routes) {
    const params = match(pattern, pathname);
    if (params) return <Suspense fallback={<Centered><Spinner lg /></Centered>}>{render(params)}</Suspense>;
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
