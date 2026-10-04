'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Search } from 'lucide-react';
import { adjustStock, getCategories, getItems, money, setItemAvailability, updateItem, type CatalogItem } from '@/lib/vendor-api';
import { Pictogram } from '@/components/glyphs';
import { DataUnavailable } from '@/components/data-unavailable';
import { MutationNotice } from '@/components/mutation-notice';
import { storeKey, useStoreId } from '@/lib/store-scope';

type AdjustReason = 'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN';

function StockAdjust({ item, onDone }: { item: CatalogItem; onDone: () => void }) {
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState<AdjustReason>('RECEIVED');
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => adjustStock(item.id, delta, reason),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--swift-subtle)] p-3">
      <span className="text-sm font-semibold">{item.name}</span>
      <input
        type="number"
        value={delta || ''}
        onChange={(e) => setDelta(Number(e.target.value))}
        placeholder="+/- qty"
        className="w-24 rounded-lg border border-[var(--swift-border)] px-2 py-1.5 text-sm"
      />
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value as AdjustReason)}
        className="rounded-lg border border-[var(--swift-border)] px-2 py-1.5 text-sm"
      >
        <option value="RECEIVED">Received stock</option>
        <option value="DAMAGED">Damaged</option>
        <option value="MANUAL">Manual correction</option>
        <option value="RECONCILE">Count reconcile</option>
        <option value="RETURN">Customer return</option>
      </select>
      <button
        onClick={() => mut.mutate()}
        disabled={mut.isPending || delta === 0}
        className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        Apply
      </button>
      <button onClick={onDone} className="text-sm text-[var(--swift-muted)]">Cancel</button>
      {error && <span className="text-sm text-[var(--swift-red)]">{error}</span>}
    </div>
  );
}

function PriceEdit({ item, onDone }: { item: CatalogItem; onDone: () => void }) {
  // `basePrice` is null when the server did not send a usable price: start the
  // editor EMPTY rather than seeding it with the string "null" (or a 0 the
  // vendor might save over their real price).
  const [price, setPrice] = useState(item.basePrice == null ? '' : String(item.basePrice));
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => updateItem(item.id, { basePrice: Number(price) }),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message),
  });
  return (
    <span className="flex items-center gap-1">
      <input
        type="number"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && Number(price) > 0 && mut.mutate()}
        autoFocus
        className="w-24 rounded-lg border border-[var(--swift-red)] px-2 py-1 text-sm"
      />
      <button
        onClick={() => mut.mutate()}
        disabled={mut.isPending || !(Number(price) > 0)}
        className="text-xs font-bold text-[var(--swift-red)]"
      >
        Save
      </button>
      <button onClick={onDone} className="text-xs text-[var(--swift-muted)]">✕</button>
      {error && <span className="text-xs text-[var(--swift-red)]">{error}</span>}
    </span>
  );
}

export default function InventoryPage() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState<string | null>(null);

  const items = useQuery({ queryKey: storeKey(storeId, 'items', 'all'), queryFn: () => getItems() });
  const categories = useQuery({ queryKey: storeKey(storeId, 'categories'), queryFn: getCategories });

  const refresh = () => queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'items') });
  const availMut = useMutation({
    mutationFn: (v: { id: string; isAvailable: boolean }) => setItemAvailability(v.id, v.isAvailable),
    onSettled: refresh,
  });

  const list = useMemo(() => {
    let rows = items.data ?? [];
    if (search) rows = rows.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()) || (i.sku ?? '').toLowerCase().includes(search.toLowerCase()));
    if (categoryId) rows = rows.filter((i) => i.category?.id === categoryId);
    if (lowOnly) rows = rows.filter((i) => i.stockQuantity != null && i.stockQuantity <= (i.lowStockThreshold ?? 5));
    return rows;
  }, [items.data, search, categoryId, lowOnly]);

  return (
    <div className="space-y-5">
      <MutationNotice errors={[availMut.error]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="sw-title">Menu</h1>
        <Link
          href="/dashboard/inventory/import"
          className="flex items-center gap-2 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)]"
        >
          <FileUp className="h-4 w-4" /> Bulk import CSV / Excel
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--swift-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or SKU"
            className="w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] py-2 pl-9 pr-3 text-sm"
          />
        </div>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-2 text-sm"
        >
          <option value="">All categories</option>
          {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="h-4 w-4 accent-[var(--swift-red)]" />
          Low stock only
        </label>
        <span className="text-sm text-[var(--swift-muted)]">{list.length} {list.length === 1 ? 'item' : 'items'}</span>
      </div>

      {items.isError && <DataUnavailable what="your menu" error={items.error} onRetry={() => void items.refetch()} />}
      {categories.isError && <DataUnavailable what="your menu categories" error={categories.error} onRetry={() => void categories.refetch()} />}
      {items.isLoading && <div className="sw-empty" role="status"><span className="sw-skeleton h-24 w-full" />Loading your menu…</div>}
      {!items.isLoading && !items.isError && !list.length && <p className="sw-board-empty">No items match.</p>}
      <div className="grid gap-x-8 wide:grid-cols-2">
        {list.map(i => <article key={i.id} aria-label={i.name} className="border-b border-[var(--swift-border)] py-5">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 flex-none place-items-center rounded-xl bg-[var(--swift-sunken)]"><Pictogram name="food" size={26} /></span>
            <div className={`min-w-0 flex-1 ${i.isAvailable ? '' : 'opacity-60'}`}><h2 className="sw-label">{i.name}</h2><p className="sw-caption">{i.category?.name ?? 'Uncategorised'}</p>
              {editingPrice === i.id ? <PriceEdit item={i} onDone={() => { setEditingPrice(null); refresh(); }} /> : <button onClick={() => setEditingPrice(i.id)} className="min-h-8 font-semibold hover:underline">{money(i.basePrice)}</button>}
            </div>
            <button role="switch" aria-label={`In stock: ${i.name}`} aria-checked={i.isAvailable} onClick={() => availMut.mutate({ id: i.id, isAvailable: !i.isAvailable })} disabled={availMut.isPending}
              className="grid h-11 w-16 flex-none place-items-center" title={i.isAvailable ? 'Live — customers can order it' : 'Hidden / sold out'}>
              <span className={`sw-stock-switch ${i.isAvailable ? 'bg-[var(--swift-red)]' : 'bg-[var(--swift-border-strong)]'}`}><span className={`sw-stock-knob ${i.isAvailable ? 'translate-x-5' : ''}`} /></span>
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-[var(--swift-muted)]">
            {!i.isAvailable && <span>Sold out</span>}
            {i.sku && <span>SKU: {i.sku}</span>}
            {i.stockQuantity == null ? <span>Stock untracked</span> : <button onClick={() => setAdjusting(adjusting === i.id ? null : i.id)} className="sw-link-btn min-h-8">{i.stockQuantity} in stock · Adjust stock</button>}
          </div>
          {adjusting === i.id && <StockAdjust item={i} onDone={() => { setAdjusting(null); refresh(); }} />}
        </article>)}
      </div>
      <p className="text-xs text-[var(--swift-muted)]">
        Photos, descriptions, options and new single items are managed in the Swift app — you can edit prices, stock and availability here.
      </p>
    </div>
  );
}
