'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, ShoppingCart, User, Store, CornerDownLeft } from 'lucide-react';
import { fetchGlobalSearch } from '@/lib/api';
import { label } from '@/lib/labels';
import { outcomeOf } from '@/lib/outcome';
import { maskedPhone } from '@/lib/review-center';
import { Modal } from '@/components/Modal';
import { NAV_ITEMS } from './nav';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · shell] ⌘K — search everything the server can search today.
//
// One box: the console's own screens ("Go to"), and — from the existing
// GET /admin/search — orders by number, people by name or phone, businesses by
// name. Nothing is searched that has no endpoint (vehicles, documents and the
// audit log come with their own PRs). Phones are masked here as the Review
// Center masks them; the full number is on the person's page. Statuses and
// types are plain words. A failed search says so — it is never "no results".
// ---------------------------------------------------------------------------

/** Search as the operator types, not per keystroke. */
function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface Option {
  key: string;
  group: string;
  href: string;
  icon: typeof Search;
  title: string;
  detail?: string;
}

const gyd = (n: unknown) => `G$${Number(n || 0).toLocaleString('en-GY', { maximumFractionDigits: 2 })}`;

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const uid = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const term = useDebounced(q.trim(), 250);
  const searchable = term.length >= 2;

  const search = useQuery({
    queryKey: ['global-search', term],
    queryFn: () => fetchGlobalSearch(term),
    enabled: searchable,
    staleTime: 15_000,
    retry: false,
  });

  const options = useMemo<Option[]>(() => {
    const needle = q.trim().toLowerCase();
    const pages = NAV_ITEMS
      .filter((n) => !needle || `${n.label} ${n.keywords ?? ''} ${n.blurb}`.toLowerCase().includes(needle))
      .slice(0, needle ? 6 : 8)
      .map((n): Option => ({ key: `page:${n.href}`, group: 'Go to', href: n.href, icon: n.icon, title: n.label, detail: n.blurb }));
    const r = searchable && search.data?.data && term === q.trim() ? search.data.data : null;
    const orders = (r?.orders ?? []).map((o): Option => ({
      key: `order:${o.id}`, group: 'Orders', href: `/orders/${o.id}`, icon: ShoppingCart,
      title: o.orderNumber, detail: [label('OrderType', o.orderType), label('OrderStatus', o.status), gyd(o.totalAmount)].join(' · '),
    }));
    const people = (r?.users ?? []).map((u): Option => ({
      key: `user:${u.id}`, group: 'People', href: `/users/${u.id}`, icon: User,
      title: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unnamed account',
      detail: [maskedPhone(u.phone), u.roles.map((role) => label('UserRole', role)).join(', '), label('UserStatus', u.status)].join(' · '),
    }));
    const businesses = (r?.vendors ?? []).map((v): Option => ({
      key: `vendor:${v.id}`, group: 'Businesses', href: `/vendors/${v.id}`, icon: Store,
      title: v.name, detail: [label('VendorType', v.vendorType), v.city, label('VendorStatus', v.status)].filter(Boolean).join(' · '),
    }));
    return [...pages, ...orders, ...people, ...businesses];
  }, [q, term, searchable, search.data]);

  useEffect(() => { setActive(0); }, [q]);

  const go = (option: Option | undefined) => {
    if (!option) return;
    onClose();
    router.push(option.href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, options.length - 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    if (event.key === 'Enter') { event.preventDefault(); go(options[active]); }
  };

  const listId = `${uid}-results`;
  const optionId = (i: number) => `${uid}-option-${i}`;
  const failed = searchable && search.isError;
  const waiting = searchable && (search.isFetching || term !== q.trim()) && !search.data;
  const groups = [...new Set(options.map((o) => o.group))];

  return (
    <Modal title="Search everything" onClose={onClose} className="mc-dialog mc-palette">
      <div className="mc-palette-field">
        <Search size={18} aria-hidden="true" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={options[active] ? optionId(active) : undefined}
          aria-label="Search everything"
          aria-describedby={`${uid}-hint`}
          placeholder="Search orders, people, businesses — or go to a screen"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
        <kbd>esc</kbd>
      </div>
      <p id={`${uid}-hint`} className="mc-palette-hint">
        {q.trim().length === 1 ? 'Type one more letter to search orders, people and businesses.' : 'Orders by number · people by name or phone · businesses by name'}
      </p>
      {failed ? (
        <p role="alert" className="mc-palette-status mc-palette-error">
          Couldn&apos;t search orders, people and businesses: {outcomeOf(search.error, { kind: 'read' }).title}.{' '}
          <button type="button" className="mc-btn mc-btn-quiet" onClick={() => void search.refetch()}>Retry</button>
        </p>
      ) : null}
      <div id={listId} role="listbox" aria-label="Results" className="mc-palette-results">
        {groups.map((group) => (
          <div key={group} role="group" aria-label={group}>
            <p className="mc-label mc-palette-group" aria-hidden="true">{group}</p>
            {options.map((o, i) => o.group !== group ? null : (
              <div
                key={o.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`mc-palette-option${i === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(o)}
              >
                <o.icon size={16} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="mc-truncate font-semibold">{o.title}</span>
                  {o.detail ? <span className="mc-truncate mc-muted text-xs">{o.detail}</span> : null}
                </span>
                {i === active ? <CornerDownLeft size={14} aria-hidden="true" className="mc-muted" /> : null}
              </div>
            ))}
          </div>
        ))}
        {waiting ? <p className="mc-palette-status" role="status">Searching…</p> : null}
        {searchable && !failed && !waiting && search.data && options.every((o) => o.group === 'Go to') ? (
          <p className="mc-palette-status" role="status">No orders, people or businesses match “{term}”.</p>
        ) : null}
      </div>
    </Modal>
  );
}

/** The header's search button, and ⌘K / Ctrl+K from anywhere. */
export function SearchLauncher() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <button type="button" className="mc-search-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Search size={16} aria-hidden="true" />
        <span className="mc-truncate">Search everything</span>
        <kbd aria-hidden="true">⌘K</kbd>
      </button>
      {open ? <CommandPalette onClose={() => setOpen(false)} /> : null}
    </>
  );
}
