'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, ShoppingCart, User, Store } from 'lucide-react';
import { fetchGlobalSearch } from '@/lib/api';

/** Small debounce so we search as the operator types, not per keystroke. */
function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const STATUS_DOT: Record<string, string> = {
  ACTIVE: 'bg-emerald-400',
  DELIVERED: 'bg-emerald-400',
  COMPLETED: 'bg-emerald-400',
  PENDING: 'bg-amber-400',
  SUSPENDED: 'bg-red-400',
  CANCELLED: 'bg-red-400',
  FAILED: 'bg-red-400',
};

/**
 * The console's jump-to-anything box: one query fans out across orders, users
 * and vendors (`/admin/search`). ⌘K / Ctrl+K focuses it from anywhere.
 */
export function GlobalSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(q.trim(), 250);

  const { data, isFetching } = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: () => fetchGlobalSearch(debounced),
    enabled: debounced.length >= 2,
    staleTime: 15_000,
  });

  // ⌘K / Ctrl+K → focus; Esc → close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Click-away closes the dropdown.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQ('');
    router.push(href);
  };

  const r = data?.data;
  const hasResults = !!r && (r.orders.length > 0 || r.users.length > 0 || r.vendors.length > 0);
  const showPanel = open && debounced.length >= 2;

  const rowCls =
    'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-white/10 transition-colors';

  return (
    <div ref={boxRef} className="relative w-96">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8E8E93]" size={18} />
      <input
        ref={inputRef}
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search orders, users, vendors…"
        className="w-full bg-[#2C2C2E] text-white pl-10 pr-12 py-2 rounded-lg text-sm border border-[#38383A] focus:border-[#E8192C] focus:outline-none"
      />
      <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#8E8E93] border border-[#38383A] rounded px-1.5 py-0.5">
        ⌘K
      </kbd>

      {showPanel && (
        <div className="absolute top-11 left-0 right-0 z-50 rounded-xl border border-[#38383A] bg-[#1C1C1E] shadow-2xl p-2 max-h-[70vh] overflow-auto">
          {isFetching && !hasResults ? (
            <p className="px-3 py-2 text-sm text-[#8E8E93]">Searching…</p>
          ) : !hasResults ? (
            <p className="px-3 py-2 text-sm text-[#8E8E93]">Nothing matches “{debounced}”.</p>
          ) : (
            <>
              {r!.orders.length > 0 && (
                <div className="mb-1">
                  <p className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-widest text-[#8E8E93]">ORDERS</p>
                  {r!.orders.map((o) => (
                    <button key={o.id} className={rowCls} onClick={() => go(`/orders/${o.id}`)}>
                      <ShoppingCart size={15} className="text-[#8E8E93] shrink-0" />
                      <span className="font-mono">{o.orderNumber}</span>
                      <span className="text-[#8E8E93]">{o.orderType.replaceAll('_', ' ').toLowerCase()}</span>
                      <span className="ml-auto flex items-center gap-2 text-[#8E8E93]">
                        ${Number(o.totalAmount).toLocaleString()}
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[o.status] ?? 'bg-sky-400'}`} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {r!.users.length > 0 && (
                <div className="mb-1">
                  <p className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-widest text-[#8E8E93]">USERS</p>
                  {r!.users.map((u) => (
                    <button key={u.id} className={rowCls} onClick={() => go(`/users/${u.id}`)}>
                      <User size={15} className="text-[#8E8E93] shrink-0" />
                      <span>{[u.firstName, u.lastName].filter(Boolean).join(' ')}</span>
                      <span className="text-[#8E8E93]">{u.phone}</span>
                      <span className="ml-auto flex items-center gap-2 text-[#8E8E93]">
                        {u.roles.join(' · ').toLowerCase()}
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[u.status] ?? 'bg-sky-400'}`} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {r!.vendors.length > 0 && (
                <div>
                  <p className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-widest text-[#8E8E93]">VENDORS</p>
                  {r!.vendors.map((v) => (
                    <button key={v.id} className={rowCls} onClick={() => go(`/vendors/${v.id}`)}>
                      <Store size={15} className="text-[#8E8E93] shrink-0" />
                      <span>{v.name}</span>
                      <span className="text-[#8E8E93]">
                        {v.vendorType.toLowerCase()}
                        {v.city ? ` · ${v.city}` : ''}
                      </span>
                      <span className={`ml-auto w-1.5 h-1.5 rounded-full ${STATUS_DOT[v.status] ?? 'bg-sky-400'}`} />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
