'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, ClipboardList, Boxes, FileUp, Receipt, Settings, ShieldCheck, Store as StoreIcon, ChevronDown } from 'lucide-react';
import { Providers } from '@/components/providers';
import { ConsoleShell } from '@/components/console-shell';
import Link from 'next/link';
import { ApiRequestError, sessionProbe, setSelectedStore } from '@/lib/auth';
import { getStores, type Store } from '@/lib/vendor-api';
import { switchStore, useStoreId } from '@/lib/store-scope';

export const NAV = [
  { href: '/dashboard', label: 'Today', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/orders', label: 'Orders', icon: ClipboardList, exact: false },
  { href: '/dashboard/inventory', label: 'Inventory', icon: Boxes, exact: true },
  { href: '/dashboard/inventory/import', label: 'Bulk import', icon: FileUp, exact: false },
  { href: '/dashboard/documents', label: 'Documents', icon: ShieldCheck, exact: true },
  { href: '/dashboard/weekly-fee', label: 'Weekly fee', icon: Receipt, exact: true },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, exact: false },
];

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
      <p role="alert" className="rounded-lg border border-[var(--swift-red)]/30 bg-white px-3 py-2 text-xs font-semibold text-[var(--swift-red)]">
        Couldn&apos;t load your stores. Actions are unavailable until this loads.
      </p>
    );
  }
  if (list.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => (list.length > 1 || !selected) && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-2 text-left"
      >
        <StoreIcon className="h-4 w-4 shrink-0 text-[var(--swift-red)]" />
        <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${selected ? '' : 'text-[var(--swift-red)]'}`}>
          {selected ? selected.name : 'Choose a store'}
        </span>
        {(list.length > 1 || !selected) && <ChevronDown className="h-4 w-4 shrink-0 text-[var(--swift-muted)]" />}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-black/10 bg-white py-1 shadow-lg">
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

function StoreShell({ children }: { children: React.ReactNode }) {
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

  return (
    <ConsoleShell home="/dashboard" title="Business" navigation={NAV}
      switcher={<StoreSwitcher storeId={storeId} onSwitch={onSwitch} list={list} isError={stores.isError && !noStoreYet} />}
      signOutBody="New orders stop showing in this browser until you sign in again. Your store, menu and orders stay with your account."
      contentKey={storeId ?? 'no-store'}>
      {noStoreYet ? (
        <div className="rounded-2xl border border-black/5 bg-white p-6">
          <p className="text-sm font-semibold">Your business isn&apos;t set up yet.</p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">Add your store&apos;s details and location to start taking orders.</p>
          <Link href="/signup?resume=business" className="mt-4 inline-block rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white">
            Finish setting up your business
          </Link>
        </div>
      ) : storeId ? children : (
        <p className="rounded-2xl border border-black/5 bg-white p-6 text-sm font-semibold text-[var(--swift-muted)]">
          Choose a store to continue.
        </p>
      )}
    </ConsoleShell>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  // [W-01] The session is an HttpOnly cookie the page cannot read, so the gate
  // asks the SERVER whether one exists instead of inspecting localStorage.
  useEffect(() => {
    let cancelled = false;
    void sessionProbe().then((session) => {
      if (cancelled) return;
      if (!session.ok) router.replace('/login');
      else setReady(true);
    });
    return () => { cancelled = true; };
  }, [router]);

  if (!ready) return null;
  return (
    <Providers>
      <StoreShell>{children}</StoreShell>
    </Providers>
  );
}
