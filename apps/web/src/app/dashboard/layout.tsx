'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, ClipboardList, Boxes, FileUp, Settings, LogOut, Store as StoreIcon, ChevronDown } from 'lucide-react';
import { Providers } from '@/components/providers';
import { clearSession, getSelectedStore, getToken, setSelectedStore } from '@/lib/auth';
import { getStores, type Store } from '@/lib/vendor-api';

const NAV = [
  { href: '/dashboard', label: 'Today', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/orders', label: 'Orders', icon: ClipboardList, exact: false },
  { href: '/dashboard/inventory', label: 'Inventory', icon: Boxes, exact: true },
  { href: '/dashboard/inventory/import', label: 'Bulk import', icon: FileUp, exact: false },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, exact: false },
];

function StoreSwitcher() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const list: Store[] = stores.data?.stores ?? [];
  const selectedId = getSelectedStore() ?? stores.data?.selectedId;
  const selected = list.find((s) => s.id === selectedId) ?? list[0];

  if (!selected) return null;
  return (
    <div className="relative">
      <button
        onClick={() => list.length > 1 && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-2 text-left"
      >
        <StoreIcon className="h-4 w-4 shrink-0 text-[var(--swift-red)]" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{selected.name}</span>
        {list.length > 1 && <ChevronDown className="h-4 w-4 shrink-0 text-[var(--swift-muted)]" />}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-black/10 bg-white py-1 shadow-lg">
          {list.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setSelectedStore(s.id);
                setOpen(false);
                // Every vendor query is scoped by the x-vendor-id header — new store, new world.
                queryClient.invalidateQueries();
              }}
              className={`block w-full truncate px-3 py-2 text-left text-sm hover:bg-[var(--swift-subtle)] ${s.id === selected.id ? 'font-bold text-[var(--swift-red)]' : ''}`}
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

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="flex min-h-screen bg-[var(--swift-subtle)]">
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col border-r border-black/5 bg-white p-4">
        <Link href="/dashboard" className="px-2 text-lg font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> Business
        </Link>
        <div className="mt-4">
          <StoreSwitcher />
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
            clearSession();
            router.replace('/login');
          }}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] hover:text-[var(--swift-ink)]"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </aside>
      <main className="ml-60 min-w-0 flex-1 p-6 lg:p-8">{children}</main>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  // localStorage only exists client-side — gate rendering on the token check.
  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) return null;
  return (
    <Providers>
      <Shell>{children}</Shell>
    </Providers>
  );
}
