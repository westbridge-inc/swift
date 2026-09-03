'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, ClipboardList, Boxes, FileUp, Settings, LogOut, Store as StoreIcon, ChevronDown } from 'lucide-react';
import { Providers } from '@/components/providers';
import { getSelectedStore, logout, sessionProbe, setSelectedStore } from '@/lib/auth';
import { getStores, type Store } from '@/lib/vendor-api';
import { switchStore } from '@/lib/store-scope';

const NAV = [
  { href: '/dashboard', label: 'Today', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/orders', label: 'Orders', icon: ClipboardList, exact: false },
  { href: '/dashboard/inventory', label: 'Inventory', icon: Boxes, exact: true },
  { href: '/dashboard/inventory/import', label: 'Bulk import', icon: FileUp, exact: false },
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
function StoreSwitcher({ storeId, onSwitch }: { storeId: string | null; onSwitch: (_id: string) => void }) {
  const [open, setOpen] = useState(false);
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  // memoised: the adopt-selection effect below depends on it, and a fresh
  // array every render would re-run that effect every render.
  const list: Store[] = useMemo(() => stores.data?.stores ?? [], [stores.data?.stores]);
  const selected = list.find((s) => s.id === storeId) ?? null;

  // Adopt the server's selection ONCE, and persist it, so the displayed store
  // and the requested store are the same fact rather than two hopeful ones.
  useEffect(() => {
    if (selected || list.length === 0) return;
    const serverChoice = list.find((s) => s.id === stores.data?.selectedId);
    if (serverChoice) onSwitch(serverChoice.id);
    else if (list.length === 1) onSwitch(list[0]!.id);
  }, [selected, list, stores.data?.selectedId, onSwitch]);

  if (stores.isError) {
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

function Shell({ children, storeId, onSwitch }: {
  children: React.ReactNode;
  storeId: string | null;
  onSwitch: (_id: string) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="flex min-h-screen bg-[var(--swift-subtle)]">
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col border-r border-black/5 bg-white p-4">
        <Link href="/dashboard" className="px-2 text-lg font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> Business
        </Link>
        <div className="mt-4">
          <StoreSwitcher storeId={storeId} onSwitch={onSwitch} />
        </div>
        <nav className="mt-4 flex-1 space-y-1">
          {NAV.map((n) => {
            const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                  active ? 'bg-[var(--swift-red)]/10 text-[var(--swift-red)]' : 'text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] hover:text-[var(--swift-ink)]'
                }`}
              >
                <n.icon className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={() => {
            // the session lives in a cookie only the server can expire
            void logout().then(() => router.replace('/login'));
          }}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] hover:text-[var(--swift-ink)]"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </aside>
      {/* [W-04] The key REMOUNTS every page below on a store change. Query
          data is removed by switchStore; this is the other half — local
          component state. The opening-hours editor seeded its rows once
          and never re-seeded, so store A's hours stayed in the form after
          a switch and Save sent them to store B. A remount makes that
          structurally impossible for every form, present and future. */}
      <main key={storeId ?? 'no-store'} className="ml-60 min-w-0 flex-1 p-6 lg:p-8">
        {storeId ? children : (
          <p className="rounded-2xl border border-black/5 bg-white p-6 text-sm font-semibold text-[var(--swift-muted)]">
            Choose a store to continue.
          </p>
        )}
      </main>
    </div>
  );
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  // The store is React state as well as localStorage: the shell must RE-RENDER
  // (and remount its subtree) the moment it changes, which a localStorage read
  // alone would never trigger.
  const [storeId, setStoreId] = useState<string | null>(() => getSelectedStore());

  const onSwitch = useCallback(
    (id: string) => {
      void switchStore(queryClient, {
        from: storeId,
        to: id,
        // Persist FIRST, so a response still in flight for the old store is
        // rejected by the response-context guard rather than cached.
        commit: (next) => {
          setSelectedStore(next);
          setStoreId(next);
        },
        confirmDiscard: (ids) =>
          window.confirm(
            `You have unsaved changes (${ids.join(', ')}). Switching stores discards them. Switch anyway?`,
          ),
      });
    },
    [queryClient, storeId],
  );

  return (
    <Shell storeId={storeId} onSwitch={onSwitch}>
      {children}
    </Shell>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
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
      <DashboardShell>{children}</DashboardShell>
    </Providers>
  );
}
