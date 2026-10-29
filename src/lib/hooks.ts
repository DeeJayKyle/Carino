import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, isOffline } from './api';
import { cacheGet, cacheSet } from './offline';

/**
 * Loads an API resource. When `cache` is set, successful results are saved to IndexedDB
 * and shown (marked stale) if the network is unavailable.
 */
export function useData<T = any>(path: string | null, opts: { cache?: boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [stale, setStale] = useState<number | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (!path) return;
    const my = ++seq.current;
    if (!silent) setLoading(true);
    try {
      const d = await api<T>(path);
      if (my !== seq.current) return;
      setData(d);
      setError(null);
      setStale(null);
      if (opts.cache) void cacheSet(path, d);
    } catch (e: any) {
      if (my !== seq.current) return;
      if (opts.cache && (e?.code === 'network' || isOffline())) {
        const cached = await cacheGet<T>(path);
        if (cached) {
          setData(cached.value);
          setStale(cached.savedAt);
          setError(null);
          return;
        }
      }
      setError(e instanceof ApiError ? e : new ApiError(0, String(e?.message ?? e)));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path, opts.cache]);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    void load();
  }, [path, load]);

  return { data, setData, error, loading, stale, reload: () => load(true) };
}

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [q]);
  return m;
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
