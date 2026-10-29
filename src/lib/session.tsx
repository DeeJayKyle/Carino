import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, patch, post, setUnauthorizedHandler } from './api';
import { cacheClear, cacheGet, cacheSet } from './offline';
import { setFormatPrefs } from './format';

export interface Me {
  user: { id: string; email: string; name: string };
  settings: any;
  server: {
    providers: { id: string; label: string; model: string; configured: boolean; capabilities: { tools: boolean; streaming: boolean; local: boolean }; pricing?: { input: number; output: number }; note?: string }[];
    search: { configured: boolean; provider: string | null };
    push: { configured: boolean; publicKey: string | null };
  };
}

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  offlineSession: boolean;
  refresh: () => Promise<void>;
  saveSettings: (patch: any) => Promise<any>;
  logout: () => Promise<void>;
  setMe: (m: Me | null) => void;
  counts: { pendingActions: number; unread: number };
  refreshCounts: () => void;
}

const Ctx = createContext<SessionCtx>(null as any);
export const useSession = () => useContext(Ctx);

export function applyAppearance(s: any) {
  const root = document.documentElement;
  const theme = s?.appearance?.theme ?? 'system';
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  root.setAttribute('data-text', s?.appearance?.textSize ?? 'normal');
  if (s?.appearance?.palette === 'midnight') root.setAttribute('data-palette', 'midnight');
  else root.removeAttribute('data-palette');
  if (s?.appearance?.reduceMotion) root.setAttribute('data-motion', 'reduce');
  else root.removeAttribute('data-motion');
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [offlineSession, setOfflineSession] = useState(false);
  const [counts, setCounts] = useState({ pendingActions: 0, unread: 0 });

  const setMe = useCallback((m: Me | null) => {
    setMeState(m);
    if (m) {
      applyAppearance(m.settings);
      setFormatPrefs(m.settings.regional);
      void cacheSet('me', m);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
      setOfflineSession(false);
    } catch (e: any) {
      if (e?.code === 'network') {
        // Offline: open with the last known session so cached data can be read.
        const cached = await cacheGet<Me>('me');
        if (cached) {
          setMe(cached.value);
          setOfflineSession(true);
        } else setMeState(null);
      } else setMeState(null);
    } finally {
      setLoading(false);
    }
  }, [setMe]);

  const refreshCounts = useCallback(() => {
    if (!me || offlineSession) return;
    Promise.all([api('/actions?status=pending&limit=1'), api('/notifications')])
      .then(([a, n]) => setCounts({ pendingActions: a.pending, unread: n.unread }))
      .catch(() => undefined);
  }, [me, offlineSession]);

  useEffect(() => {
    setUnauthorizedHandler(() => setMeState(null));
    void refresh();
  }, [refresh]);

  useEffect(() => {
    refreshCounts();
    const t = setInterval(refreshCounts, 60_000);
    const onFocus = () => refreshCounts();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCounts]);

  const saveSettings = useCallback(async (p: any) => {
    const s = await patch('/settings', p);
    setMeState((m) => {
      if (!m) return m;
      const next = { ...m, settings: s };
      applyAppearance(s);
      setFormatPrefs(s.regional);
      void cacheSet('me', next);
      return next;
    });
    return s;
  }, []);

  const logout = useCallback(async () => {
    await post('/auth/logout').catch(() => undefined);
    await cacheClear();
    setMeState(null);
  }, []);

  return <Ctx.Provider value={{ me, loading, offlineSession, refresh, saveSettings, logout, setMe, counts, refreshCounts }}>{children}</Ctx.Provider>;
}
