'use client';

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getSessionPrincipal, restoreSession, sessionProbe, subscribeSession } from '@/lib/auth';
import { getMarketDepth } from '@/lib/customer';
import { cartItemCount, customerCartKey, readShellCart, readShellPerson, shellPersonKey } from '@/lib/shell-data';
import { marketTabVisible } from '@/lib/app-rules';
import { customerRoute, HOME_PATH } from '@/lib/customer-routes';
import { Providers } from '@/components/providers';
import { CustomerSessionProvider, type CustomerSession, type NearPoint, type SessionStatus } from '@/components/customer-session';
import { BackRow, ContentSkeleton, ShellNavProvider, SideRail, SignInDoor, SwitchAppSheet, TabBar } from '@/components/customer-shell';
import CartSkeleton from './cart/loading';
import OrderDetailSkeleton from './orders/[id]/loading';
import { OrdersSkeleton } from '@/components/customer-skeletons';
import { OfflineNotice } from '@/components/offline-notice';
import { useGuestBasket } from '@/lib/basket-state';
import { OrderingContextProvider, showsOrderingContext } from '@/components/ordering-context';
import { InstallPrompt } from '@/components/install-prompt';

// Upload code is needed only after sign-in with a browser basket.
const OrderingContextBar = lazy(() => import('@/components/ordering-context-bar').then(module => ({ default: module.OrderingContextBar })));
const GuestBasketSync = lazy(() => import('@/components/guest-basket').then(module => ({ default: module.GuestBasketSync })));

// The customer ordering app. Opening swiftgy.com lands here, on Home.
//
// [Q7b] THE SHELL STAYS PUT. It used to re-run the session check on every
// page change and blank the whole screen with "Loading…" each time, so moving
// between pages felt like reloading a website. Now:
//   - the server is asked ONCE per page load ([W-01]: the session is an
//     HttpOnly cookie, so its word is the only word), and told of later
//     changes — sign-in, sign-out, an expired session — by lib/auth;
//   - the header and the tabs never unmount; pages change underneath them;
//   - browsing is public, like the phone app. A private page (cart, orders,
//     profile) opened by a guest shows a sign-in door inside the app, and a
//     page still waiting for its answer shows its shape, never a blank screen.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <OrderingContextProvider><CustomerShell>{children}</CustomerShell></OrderingContextProvider>
    </Providers>
  );
}

interface ShellSession {
  status: SessionStatus;
  principal: string | null;
  /** The refresh cookie has been tried (or the server ended the session). */
  restoreTried: boolean;
  /** Bumped when the person changes after the first answer — a sign-out, a
   *  session the server ended, a restored session — in the same update as the
   *  change itself, so nothing keyed to it can render one person's answer for
   *  another. (Signing in as someone happens on /login, outside this shell:
   *  the shell and its whole query cache unmount on the way there.) */
  epoch: number;
}

type SessionAnswer = Omit<ShellSession, 'epoch'>;

/** The first answer is learning who this is; any later change of person is a
 *  different person. */
function settle(current: ShellSession, next: SessionAnswer): ShellSession {
  const changed = current.status !== 'checking' && current.principal !== next.principal;
  return { ...next, epoch: changed ? current.epoch + 1 : current.epoch };
}

function useShellSession(): ShellSession & { ensureSignedIn: () => Promise<boolean> } {
  const [state, setState] = useState<ShellSession>({ status: 'checking', principal: null, restoreTried: false, epoch: 0 });
  const probe = useRef<Promise<void> | null>(null);
  const restore = useRef<Promise<boolean> | null>(null);
  const restoreSpent = useRef(false);

  // The one probe of this page load. Started by the shell's mount, or by the
  // first page that needs the answer before that — whichever comes first.
  const startProbe = useCallback(() => {
    probe.current ??= sessionProbe().then((session) => {
      setState((current) => settle(current, session.ok
        ? { status: 'signed-in', principal: getSessionPrincipal(), restoreTried: current.restoreTried }
        : { status: 'guest', principal: null, restoreTried: current.restoreTried }));
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
      if (principal) return settle(current, { status: 'signed-in', principal, restoreTried: current.restoreTried });
      return current.status === 'checking' ? current : settle(current, { status: 'guest', principal: null, restoreTried: true });
    });
  }), []);

  const ensureSignedIn = useCallback(async () => {
    await startProbe();
    if (getSessionPrincipal()) return true;
    if (restoreSpent.current) return false;
    restore.current ??= restoreSession().then((session) => {
      restoreSpent.current = true;
      setState((current) => settle(current, session.ok
        ? { status: 'signed-in', principal: getSessionPrincipal(), restoreTried: true }
        : { status: 'guest', principal: null, restoreTried: true }));
      return session.ok;
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
  const { status, principal, restoreTried, epoch, ensureSignedIn } = session;
  const depth = useInAppDepth(pathname);
  const [switching, setSwitching] = useState(false);
  const [backClaims, setBackClaims] = useState(0);
  const [nearPoint, setNearPoint] = useState<NearPoint | null>(null);

  useEffect(() => { setSwitching(false); }, [pathname]);

  // [Q7b] Market is a tab only when the server's depth verdict says so — the
  // phone app's rule, read from the same public endpoint.
  const market = useQuery({ queryKey: ['market', 'depth'], queryFn: getMarketDepth, staleTime: 5 * 60_000, retry: false });
  const marketVisible = marketTabVisible(market.data);

  // [WEB-REDESIGN] The rail and the dock show how many things are in the
  // cart, and the rail shows who is signed in. Both are the account's own
  // reads (the cart and profile the phone app reads), asked only once someone
  // is signed in and keyed to that person, so a sign-out never shows the last
  // person's count. A failed read shows no badge, never a made-up number.
  const scope = principal ?? 'guest';
  const signedIn = status === 'signed-in';
  const cart = useQuery({ queryKey: customerCartKey(scope, epoch), queryFn: readShellCart, enabled: signedIn, staleTime: 30_000, retry: false });
  const me = useQuery({ queryKey: shellPersonKey(scope, epoch), queryFn: readShellPerson, enabled: signedIn, staleTime: 5 * 60_000, retry: false });
  const guestBasket = useGuestBasket();
  const cartCount = signedIn ? cartItemCount(cart.data) : guestBasket.lines.reduce((n, l) => n + l.quantity, 0);

  // A private page opened with an expired access cookie: spend the refresh
  // cookie once before deciding this is a guest.
  useEffect(() => {
    if (!route.public && status === 'guest' && !restoreTried) void ensureSignedIn();
  }, [route.public, status, restoreTried, ensureSignedIn]);

  const goBack = useCallback(() => {
    if (depth.current > 0) router.back();
    else router.push(route.parent ?? HOME_PATH);
  }, [depth, router, route.parent]);

  const claimBack = useCallback(() => {
    setBackClaims((count) => count + 1);
    return () => setBackClaims((count) => count - 1);
  }, []);

  // Where sign-in brings the person back to: this page, with its query (a
  // store's ?item=, a category) — read when the link is drawn or tapped.
  const returnPath = useCallback(
    () => `${pathname}${typeof window === 'undefined' ? '' : window.location.search}`,
    [pathname],
  );

  const context = useMemo<CustomerSession>(
    () => ({ status, scope: principal ?? 'guest', epoch, ensureSignedIn, nearPoint, setNearPoint }),
    [status, principal, epoch, ensureSignedIn, nearPoint],
  );
  const showBack = route.parent !== null;
  const openSwitchApp = useCallback(() => setSwitching(true), []);
  const nav = useMemo(() => ({ showBack, goBack, claimBack, openSwitchApp }), [showBack, goBack, claimBack, openSwitchApp]);

  let content: React.ReactNode;
  if (route.public || status === 'signed-in') content = children;
  else if (status === 'guest' && restoreTried) content = <SignInDoor door={route.door} returnPath={returnPath()} />;
  else content = <div aria-label="Opening this page">{pathname === '/cart' ? <CartSkeleton /> : pathname === '/orders' ? <OrdersSkeleton /> : pathname.startsWith('/orders/') ? <OrderDetailSkeleton /> : <ContentSkeleton />}</div>;

  // [PWA-1] Installed on an iPhone the app runs edge to edge: the page pads
  // below the status bar, the dock sits above the home bar, and the page ends
  // above both. Every inset is zero in an ordinary browser tab. `--swift-dock`
  // is how far fixed things (the install card, a store's cart button) must sit
  // above the bottom: the dock on phones, the home bar alone from 760 px up.
  return (
    <CustomerSessionProvider value={context}>
      <ShellNavProvider value={nav}>
        <div className="swift-app min-h-screen bg-[var(--swift-canvas)] [--swift-dock:calc(60px_+_env(safe-area-inset-bottom))] wide:flex wide:[--swift-dock:env(safe-area-inset-bottom)]">
          <SideRail
            activeTab={route.tab}
            marketVisible={marketVisible}
            cartCount={cartCount}
            status={status}
            person={me.data ?? null}
            returnPath={returnPath}
            onSwitchApp={openSwitchApp}
          />
          <main className="min-w-0 flex-1 pb-[calc(var(--swift-dock)_+_40px)] pt-[env(safe-area-inset-top)]">
            <div className="sw-page">
              {showsOrderingContext(pathname) ? <Suspense fallback={<div aria-hidden="true" className="py-3"><div className="min-h-11" /></div>}><OrderingContextBar /></Suspense> : null}
              <OfflineNotice />
              {status === 'signed-in' && guestBasket.lines.length > 0 ? <Suspense fallback={null}><GuestBasketSync /></Suspense> : null}
              {showBack && backClaims === 0 ? <BackRow /> : null}
              <div key={pathname} className="swift-route-in">{content}</div>
            </div>
          </main>
          <TabBar activeTab={route.tab} marketVisible={marketVisible} cartCount={cartCount} />
          {switching ? <SwitchAppSheet onClose={() => setSwitching(false)} /> : null}
          {/* [PWA-1] Offered on Home only, never over a cart, checkout or live
              order. Mounted from the first render, so an install event that
              lands before Home does is still caught. */}
          <InstallPrompt enabled={pathname === HOME_PATH} />
        </div>
      </ShellNavProvider>
    </CustomerSessionProvider>
  );
}
