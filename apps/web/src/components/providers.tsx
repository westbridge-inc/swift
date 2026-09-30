'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { currentSessionEpoch, subscribeSession, verifySessionNow } from '@/lib/auth';
import { customerRoute } from '@/lib/customer-routes';

const CacheIdentity = createContext({ ready: true, epoch: 0 });
export const useCacheIdentityReady = () => useContext(CacheIdentity).ready;
export const usePrivateCacheEpoch = () => useContext(CacheIdentity).epoch;

// Only Market's credential-free, fixed public endpoints are safe without a
// current identity. Clear the entire client on an auth transition, including
// inactive queries, mutations and pending responses, rather than guessing
// which of its other keys contain personal data.
function hasPrivateQueries(client: QueryClient): boolean {
  return client.getQueryCache().getAll().some((query) => query.queryKey[0] !== 'market');
}

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true } } });
}

export function Providers({ children, preserveShell = false }: { children: React.ReactNode; preserveShell?: boolean }) {
  const pathname = usePathname();
  const epoch = useSyncExternalStore(subscribeSession, currentSessionEpoch, () => 0);
  const [cache, setCache] = useState(() => ({ epoch, client: createClient() }));
  const { client } = cache;
  // External-store snapshots are checked before commit, including when a
  // channel event arrives between rendering a route and committing it.
  if (cache.epoch !== epoch) setCache({ epoch, client: createClient() });
  const [proof, setProof] = useState({ pathname, ready: true, checkAt: 0 });
  const lastResume = useRef(-Infinity);
  // Set during render so the new route cannot paint cached personal data for
  // even one frame while its effect waits for the server.
  if (proof.pathname !== pathname) setProof({ pathname, ready: !hasPrivateQueries(client), checkAt: 0 });
  const ready = proof.pathname === pathname && proof.ready;

  useLayoutEffect(() => subscribeSession(() => {
    if (currentSessionEpoch() === cache.epoch) return;
    // clear() cancels pending queries synchronously, even without a fetch
    // abort handler, before their promise can populate any observer.
    client.clear();
    // A late mutation rollback retains its old client; it must not be able to
    // repopulate the new person's cache after the transition.
    setCache({ epoch: currentSessionEpoch(), client: createClient() });
  }), [client, cache.epoch]);

  useEffect(() => {
    const recheck = () => {
      // Private component state exists independently of QueryClient. Public
      // routes with account-scoped queries still need the same protection.
      if (customerRoute(pathname).public && !hasPrivateQueries(client)) return;
      // Mask every resume, even inside the rate limit. A missed cookie
      // change can happen immediately after the previous successful probe.
      setProof({ pathname, ready: false, checkAt: Math.max(Date.now(), lastResume.current + 15_000) });
    };
    const visible = () => { if (document.visibilityState === 'visible') recheck(); };
    window.addEventListener('focus', recheck);
    window.addEventListener('pageshow', recheck);
    window.addEventListener('online', recheck);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', recheck);
      window.removeEventListener('pageshow', recheck);
      window.removeEventListener('online', recheck);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, pathname]);

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    const verify = () => {
      lastResume.current = Date.now();
      void verifySessionNow({ fresh: true }).then(() => {
        if (cancelled) return;
        // A newer resume owns its own proof; an older result cannot unmask it.
        setProof((current) => current === proof ? { ...current, ready: true } : current);
      });
    };
    const delay = Math.max(0, proof.checkAt - Date.now());
    const timer = delay > 0 ? window.setTimeout(verify, delay) : undefined;
    if (!delay) verify();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [proof, ready]);

  return <QueryClientProvider client={client}>
    <CacheIdentity.Provider value={{ ready, epoch }}>
      <Fragment key={preserveShell ? 'shell' : epoch}>{preserveShell || ready ? children : <p role="status">Checking your account…</p>}</Fragment>
    </CacheIdentity.Provider>
  </QueryClientProvider>;
}

/** Standalone pages retain same-session drafts while masked and discard all
 * component state and refs when the shared session epoch changes. */
export function SessionBoundary({ children }: { children: React.ReactNode }) {
  return <Providers preserveShell><SessionContent>{children}</SessionContent></Providers>;
}

function SessionContent({ children }: { children: React.ReactNode }) {
  const { ready, epoch } = useContext(CacheIdentity);
  return <>
    {!ready && <p role="status">Checking your account…</p>}
    <div key={epoch} hidden={!ready} inert={!ready}>{children}</div>
  </>;
}
