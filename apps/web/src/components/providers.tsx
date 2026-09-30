'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { sessionProbe, subscribePrivateCacheInvalidation } from '@/lib/auth';

const CacheIdentity = createContext({ ready: true, epoch: 0 });
export const useCacheIdentityReady = () => useContext(CacheIdentity).ready;
export const usePrivateCacheEpoch = () => useContext(CacheIdentity).epoch;

// Only Market's credential-free, fixed public endpoints are safe without a
// current identity. Clear the entire client on an auth transition, including
// inactive queries, mutations and pending responses, rather than guessing
// which of its other keys contain personal data.
function hasPrivateData(client: QueryClient): boolean {
  return client.getQueryCache().getAll().some((query) => query.queryKey[0] !== 'market' && query.state.data !== undefined);
}

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true } } });
}

export function Providers({ children, preserveShell = false }: { children: React.ReactNode; preserveShell?: boolean }) {
  const pathname = usePathname();
  const [client, setClient] = useState(createClient);
  const [epoch, setEpoch] = useState(0);
  const [proof, setProof] = useState({ pathname, ready: true });
  // Set during render so the new route cannot paint cached personal data for
  // even one frame while its effect waits for the server.
  if (proof.pathname !== pathname) setProof({ pathname, ready: !hasPrivateData(client) });
  const ready = proof.pathname === pathname && proof.ready;

  useLayoutEffect(() => subscribePrivateCacheInvalidation(() => {
    client.clear();
    // A late mutation rollback retains its old client; it must not be able to
    // repopulate the new person's cache after the transition.
    setClient(createClient());
    setEpoch((value) => value + 1); // discard forms and observers as well
  }), [client]);

  useEffect(() => {
    const recheck = () => { if (hasPrivateData(client)) setProof({ pathname, ready: false }); };
    const visible = () => { if (document.visibilityState === 'visible') recheck(); };
    window.addEventListener('focus', recheck);
    window.addEventListener('pageshow', recheck);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', recheck);
      window.removeEventListener('pageshow', recheck);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, pathname]);

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled) return;
      if (!session.ok) {
        client.clear(); // offline/unknown must not reuse proof
        setClient(createClient());
        setEpoch((value) => value + 1);
      }
      setProof({ pathname, ready: true });
    });
    return () => { cancelled = true; };
  }, [client, pathname, ready]);

  return <QueryClientProvider client={client}>
    <CacheIdentity.Provider value={{ ready, epoch }}>
      <Fragment key={preserveShell ? 'shell' : epoch}>{preserveShell || ready ? children : <p role="status">Checking your account…</p>}</Fragment>
    </CacheIdentity.Provider>
  </QueryClientProvider>;
}
