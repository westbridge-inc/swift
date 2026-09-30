'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSessionPrincipal, restoreSession, sessionProbe, subscribeSession } from '@/lib/auth';
import { getMarketDepth } from '@/lib/customer';
import { marketTabVisible } from '@/lib/app-rules';
import { customerRoute, HOME_PATH } from '@/lib/customer-routes';
import { Providers, useCacheIdentityReady, usePrivateCacheEpoch } from '@/components/providers';
import { CustomerSessionProvider, type CustomerSession, type NearPoint, type SessionStatus } from '@/components/customer-session';
import { ContentSkeleton, SignInDoor, TabBar, TopBar } from '@/components/customer-shell';
import CartSkeleton from './cart/loading';
import OrderDetailSkeleton from './orders/[id]/loading';
import { OrdersSkeleton } from '@/components/customer-skeletons';
import { OfflineNotice } from '@/components/offline-notice';
import { InstallPrompt } from '@/components/install-prompt';

// The customer ordering app. Opening swiftgy.com lands here, on Home.
//
// [Q7b] THE SHELL STAYS PUT. It used to re-run the session check on every
// page change and blank the whole screen with "Loading…" each time, so moving
// between pages felt like reloading a website. Now:
//   - the shell asks for initial identity; Providers revalidates before
//     private-cache reuse on navigation/resume. HttpOnly cookies make the
//     server the authority; lib/auth also relays cross-tab invalidation;
//   - the header and the tabs never unmount; pages change underneath them;
//   - browsing is public, like the phone app. A private page (cart, orders,
//     profile) opened by a guest shows a sign-in door inside the app, and a
//     page still waiting for its answer shows its shape, never a blank screen.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers preserveShell>
      <CustomerShell>{children}</CustomerShell>
    </Providers>
  );
}

interface ShellSession {
  status: SessionStatus;
  principal: string | null;
  /** The refresh cookie has been tried (or the server ended the session). */
  restoreTried: boolean;
}

function useShellSession(): ShellSession & { ensureSignedIn: () => Promise<boolean> } {
  const [state, setState] = useState<ShellSession>({ status: 'checking', principal: null, restoreTried: false });
  const probe = useRef<Promise<void> | null>(null);
  const restore = useRef<Promise<boolean> | null>(null);
  const restoreSpent = useRef(false);

  // The one probe of this page load. Started by the shell's mount, or by the
  // first page that needs the answer before that — whichever comes first.
  const startProbe = useCallback(() => {
    probe.current ??= sessionProbe().then(() => {
      // An obsolete answer cannot overwrite a newer subscription update.
      // Derive chrome only from the existing, currently settled principal.
      setState((current) => {
        const principal = getSessionPrincipal();
        return { status: principal ? 'signed-in' : 'guest', principal, restoreTried: current.restoreTried };
      });
    });
    return probe.current;
  }, []);

  useEffect(() => { void startProbe(); }, [startProbe]);

  // Every later change arrives here: a sign-out, or a session the server
  // ended mid-visit (apiFetch clears it on a final 401).
  useEffect(() => subscribeSession(() => {
    const principal = getSessionPrincipal();
    if (!principal) restoreSpent.current = true;
    setState((current) => {
      if (principal) return { status: 'signed-in', principal, restoreTried: current.restoreTried };
      return current.status === 'checking' ? current : { status: 'guest', principal: null, restoreTried: true };
    });
  }), []);

  const ensureSignedIn = useCallback(async () => {
    await startProbe();
    if (getSessionPrincipal()) return true;
    if (restoreSpent.current) return false;
    restore.current ??= restoreSession().then(() => {
      restoreSpent.current = true;
      const principal = getSessionPrincipal();
      setState({ status: principal ? 'signed-in' : 'guest', principal, restoreTried: true });
      return principal !== null;
    });
    return restore.current;
  }, [startProbe]);

  return { ...state, ensureSignedIn };
}

/**
 * How many pages deep the person is inside the app, so a back button can use
 * the history when there is some and go to the page's parent when there is
 * none (opened from a link, a QR code or the home-screen icon).
 */
function useInAppDepth(pathname: string) {
  const depth = useRef(0);
  const lastPath = useRef(pathname);
  const popped = useRef(false);

  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname !== lastPath.current) popped.current = true;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    if (popped.current) {
      popped.current = false;
      depth.current = Math.max(0, depth.current - 1);
    } else {
      depth.current += 1;
    }
  }, [pathname]);

  return depth;
}

function CustomerShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const route = customerRoute(pathname);
  const session = useShellSession();
  const cacheIdentityReady = useCacheIdentityReady();
  const cacheEpoch = usePrivateCacheEpoch();
  const { status, principal, restoreTried, ensureSignedIn } = session;
  const depth = useInAppDepth(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const [location, setLocation] = useState<{ epoch: number; point: NearPoint | null }>(() => ({ epoch: cacheEpoch, point: null }));
  const nearPoint = location.epoch === cacheEpoch ? location.point : null;
  const setNearPoint = useCallback((point: NearPoint | null) => {
    // A geolocation callback from the old subtree retains its old epoch.
    setLocation({ epoch: cacheEpoch, point });
  }, [cacheEpoch]);

  useEffect(() => { setMenuOpen(false); }, [pathname]);

  // [Q7b] Market is a tab only when the server's depth verdict says so — the
  // phone app's rule, read from the same public endpoint.
  const [marketVisible, setMarketVisible] = useState(false);

  // A private page opened with an expired access cookie: spend the refresh
  // cookie once before deciding this is a guest.
  useEffect(() => {
    if (!route.public && status === 'guest' && !restoreTried) void ensureSignedIn();
  }, [route.public, status, restoreTried, ensureSignedIn]);

  const goBack = useCallback(() => {
    if (depth.current > 0) router.back();
    else router.push(route.parent ?? HOME_PATH);
  }, [depth, router, route.parent]);

  // Where sign-in brings the person back to: this page, with its query (a
  // store's ?item=, a category) — read when the link is drawn or tapped.
  const returnPath = useCallback(
    () => `${pathname}${typeof window === 'undefined' ? '' : window.location.search}`,
    [pathname],
  );

  const context = useMemo<CustomerSession>(
    () => ({ status, scope: principal ?? 'guest', epoch: cacheEpoch, ensureSignedIn, nearPoint, setNearPoint }),
    [status, principal, cacheEpoch, ensureSignedIn, nearPoint, setNearPoint],
  );

  let content: React.ReactNode;
  if (route.public || status === 'signed-in') content = children;
  else if (status === 'guest' && restoreTried) content = <SignInDoor door={route.door} returnPath={returnPath()} />;
  else content = <div aria-label="Opening this page">{pathname === '/cart' ? <CartSkeleton /> : pathname === '/orders' ? <OrdersSkeleton /> : pathname.startsWith('/orders/') ? <OrderDetailSkeleton /> : <ContentSkeleton />}</div>;

  // [PWA-1] Installed on an iPhone the app runs edge to edge: the header pads
  // below the status bar, the dock sits above the home bar, and the page ends
  // above both. Every inset is zero in an ordinary browser tab. `--swift-dock`
  // is how far fixed things (the install card, a store's cart button) must sit
  // above the bottom: the dock on phones, the home bar alone from md up.
  return (
    <CustomerSessionProvider value={context}>
      <div className="swift-app min-h-screen [--swift-dock:calc(3.5rem_+_env(safe-area-inset-bottom))] md:[--swift-dock:env(safe-area-inset-bottom)]">
        <TopBar
          activeTab={route.tab}
          marketVisible={marketVisible}
          status={status}
          showBack={route.parent !== null}
          onBack={goBack}
          menuOpen={menuOpen}
          onMenuChange={setMenuOpen}
          returnPath={returnPath}
        />
        <main className="mx-auto max-w-6xl px-4 pt-4 pb-[calc(5rem_+_env(safe-area-inset-bottom))] md:pt-6 md:pb-[calc(1.5rem_+_env(safe-area-inset-bottom))]">
          <OfflineNotice />
          {!cacheIdentityReady && <div aria-label="Opening this page"><ContentSkeleton /></div>}
          {/* Retain same-session drafts while proving identity, but never paint
              or allow interaction with them. An epoch change remounts it all. */}
          <div key={`${pathname}:${cacheEpoch}`} hidden={!cacheIdentityReady} inert={!cacheIdentityReady} className="swift-route-in">{content}</div>
        </main>
        <MarketAvailability key={cacheEpoch} onChange={setMarketVisible} />
        <TabBar activeTab={route.tab} marketVisible={marketVisible} />
        {/* [PWA-1] Offered on Home only, never over a cart, checkout or live
            order. Mounted from the first render, so an install event that
            lands before Home does is still caught. */}
        <InstallPrompt enabled={pathname === HOME_PATH} />
      </div>
    </CustomerSessionProvider>
  );
}

/** The Market page owns depth while its server response streams. Merely
 * disabling useQuery would still create an empty entry and defer hydration. */
function MarketAvailability({ onChange }: { onChange: (_visible: boolean) => void }) {
  const pathname = usePathname();
  return pathname === '/market' ? <HydratedMarketAvailability onChange={onChange} /> : <QueriedMarketAvailability onChange={onChange} />;
}

function HydratedMarketAvailability({ onChange }: { onChange: (_visible: boolean) => void }) {
  const client = useQueryClient();
  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(notify), [client]);
  const snapshot = useCallback(() => marketTabVisible(client.getQueryData(['market', 'depth'])), [client]);
  const visible = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { onChange(visible); }, [onChange, visible]);
  return null;
}

function QueriedMarketAvailability({ onChange }: { onChange: (_visible: boolean) => void }) {
  const market = useQuery({ queryKey: ['market', 'depth'], queryFn: getMarketDepth, staleTime: 5 * 60_000, retry: false });
  const visible = marketTabVisible(market.data);
  useEffect(() => { onChange(visible); }, [onChange, visible]);
  return null;
}
