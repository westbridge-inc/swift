'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, ClipboardList, Boxes, UserRound, Store as StoreIcon, ChevronDown } from 'lucide-react';
import { Providers } from '@/components/providers';
import { ConsoleUnreachable, useConsoleSession } from '@/components/console-session';
import type { ShellPerson } from '@/components/customer-shell';
import { ConsoleShell } from '@/components/console-shell';
import Link from 'next/link';
import { ApiRequestError, setSelectedStore } from '@/lib/auth';
import { getStores, type Store } from '@/lib/vendor-api';
import { switchStore, useStoreId } from '@/lib/store-scope';
import { catalogueName, type CatalogueName } from '@/lib/catalogue-name';
import { useStoreRole } from '@/lib/store-role';
import type { VendorMemberRole } from '@/lib/vendor-hub';
import { StoreLiveFeed } from '@/components/store-live-feed';

/**
 * The business console's places: the app's four sections
 * (apps/mobile/src/modules/vendor/VendorStack.tsx), owner ruling 11 Oct 2026.
 * The items tab is named for the store's type (lib/catalogue-name); staff see
 * it as "Availability" and have no Insights, exactly as in the app. Weekly fee,
 * bulk import and hours are reached from the Orders home and Account.
 */
export const dashboardNav = (catalogue: CatalogueName, role: VendorMemberRole | undefined) => {
  const manager = role === 'OWNER' || role === 'MANAGER';
  return [
    { href: '/dashboard/orders', label: 'Orders', icon: ClipboardList, exact: false },
    { href: '/dashboard/inventory', label: manager ? catalogue : 'Availability', icon: Boxes, exact: false },
    ...(manager ? [{ href: '/dashboard/insights', label: 'Insights', icon: BarChart3, exact: false }] : []),
    // Account is the store's settings page until the app's Account screen lands (PR D).
    { href: '/dashboard/settings', label: 'Account', icon: UserRound, exact: false },
  ];
};

/**
 * [W-04 / W-05] The store switcher is the tenant boundary of this console.
 *
 * W-05: it used to render `list[0]` whenever the persisted selection matched
 * nothing — a purely VISUAL default. Requests carry `x-vendor-id` from the
 * persisted value, so the header could name one store while every request asked
 * about another (or, with nothing persisted, whichever the server defaults to).
 * A displayed store that is not the requested store is worse than no store, so
 * the fallback is gone: the server's own `selectedId` is ADOPTED AND PERSISTED
 * when it matches a store the operator owns, and otherwise the operator is
 * asked to choose. Nothing is ever merely shown.
 */
function StoreSwitcher({ storeId, onSwitch, list, isError }: {
  storeId: string | null;
  onSwitch: (_id: string) => void;
  list: Store[];
  isError: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = list.find((s) => s.id === storeId) ?? null;

  if (isError) {
    return (
      <p role="alert" className="rounded-lg border border-[var(--swift-red)]/30 bg-[var(--swift-card)] px-3 py-2 text-xs font-semibold text-[var(--swift-red)]">
        Couldn&apos;t load your stores. Actions are unavailable until this loads.
      </p>
    );
  }
  if (list.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => (list.length > 1 || !selected) && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-2 text-left"
      >
        <StoreIcon className="h-4 w-4 shrink-0 text-[var(--swift-red)]" />
        <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${selected ? '' : 'text-[var(--swift-red)]'}`}>
          {selected ? selected.name : 'Choose a store'}
        </span>
        {(list.length > 1 || !selected) && <ChevronDown className="h-4 w-4 shrink-0 text-[var(--swift-muted)]" />}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] py-1 shadow-lg">
          {list.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                onSwitch(s.id);
                setOpen(false);
              }}
              className={`block w-full truncate px-3 py-2 text-left text-sm hover:bg-[var(--swift-subtle)] ${s.id === selected?.id ? 'font-bold text-[var(--swift-red)]' : ''}`}
            >
              {s.name}
              <span className="ml-2 text-xs text-[var(--swift-muted)]">{s.city ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StoreShell({ children, person }: { children: React.ReactNode; person: ShellPerson | null }) {
  const queryClient = useQueryClient();
  // The store is React state as well as localStorage: the shell must RE-RENDER
  // (and remount its subtree) the moment it changes, which a localStorage read
  // alone would never trigger.
  const storeId = useStoreId();
  const stores = useQuery({
    queryKey: ['stores'],
    queryFn: getStores,
    // "No store yet" (404) is an answer, not a hiccup: never retried.
    retry: (failures, error) => !(error instanceof ApiRequestError && error.status === 404) && failures < 1,
  });
  // A business account whose store was never created: the server answers 404.
  // That is a step still to do, not a failure.
  const noStoreYet = stores.error instanceof ApiRequestError && stores.error.status === 404;
  const list: Store[] = useMemo(() => stores.data?.stores ?? [], [stores.data?.stores]);

  const onSwitch = useCallback(
    (id: string) => {
      void switchStore(queryClient, {
        from: storeId,
        to: id,
        // Persist FIRST, so a response still in flight for the old store is
        // rejected by the response-context guard rather than cached.
        commit: (next) => {
          setSelectedStore(next);
        },
        confirmDiscard: (ids) =>
          window.confirm(
            `You have unsaved changes (${ids.join(', ')}). Switching stores discards them. Switch anyway?`,
          ),
      });
    },
    [queryClient, storeId],
  );

  // The same switcher is drawn in the desktop rail and the phone drawer.
  // Resolve the server's store once here so opening the drawer cannot run a
  // second adoption against the same old selection.
  useEffect(() => {
    if (list.some((s) => s.id === storeId) || list.length === 0) return;
    const serverChoice = list.find((s) => s.id === stores.data?.selectedId);
    if (serverChoice) onSwitch(serverChoice.id);
    else if (list.length === 1) onSwitch(list[0]!.id);
  }, [storeId, list, stores.data?.selectedId, onSwitch]);

  const selected = list.find((s) => s.id === storeId) ?? list.find((s) => s.id === stores.data?.selectedId);
  const { role } = useStoreRole();
  const navigation = useMemo(() => dashboardNav(catalogueName(selected?.vendorType), role), [selected?.vendorType, role]);

  // [PERF row 8] The store's live feed, for a store the server listed for this account.
  const feedStore = storeId && list.some((s) => s.id === storeId) ? storeId : null;
  return (<>
    {feedStore && <StoreLiveFeed key={feedStore} storeId={feedStore} />}
    <ConsoleShell person={person} home="/dashboard" title="Business" navigation={navigation}
      switcher={<StoreSwitcher storeId={storeId} onSwitch={onSwitch} list={list} isError={stores.isError && !noStoreYet} />}
      signOutBody="New orders stop showing in this browser until you sign in again. Your store, menu and orders stay with your account."
      contentKey={storeId ?? 'no-store'}>
      {noStoreYet ? (
        <div className="sw-card p-6">
          <p className="text-sm font-semibold">Your business isn&apos;t set up yet.</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">Add your store&apos;s details and location to start taking orders.</p>
          <Link href="/signup?resume=business" className="sw-btn sw-btn-md mt-4">
            Finish setting up your business
          </Link>
        </div>
      ) : storeId ? children : (
        <p className="sw-card p-6 text-sm font-semibold text-[var(--swift-muted)]">
          Choose a store to continue.
        </p>
      )}
    </ConsoleShell>
  </>);
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  // [W-01 · UI-SWEEP U23] Only the server saying "no session" goes to /login;
  // a check that could not reach Swift says so instead (components/console-session).
  const gate = useConsoleSession();
  if (gate.phase === 'unreachable') return <ConsoleUnreachable onRetry={gate.retry} />;
  if (gate.phase !== 'ready') return <div className="sw-page sw-empty" role="status">Opening your business…</div>;
  return (
    <Providers offline="fail">
      <StoreShell person={gate.person}>{children}</StoreShell>
    </Providers>
  );
}
