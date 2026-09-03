'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Search } from 'lucide-react';
import { adjustStock, getCategories, getItems, money, setItemAvailability, updateItem, type CatalogItem } from '@/lib/vendor-api';
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
        className="w-24 rounded-lg border border-black/10 px-2 py-1.5 text-sm"
      />
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value as AdjustReason)}
        className="rounded-lg border border-black/10 px-2 py-1.5 text-sm"
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
        <h1 className="text-2xl font-extrabold">Inventory</h1>
        <Link
          href="/dashboard/inventory/import"
          className="flex items-center gap-2 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)]"
        >
          <FileUp className="h-4 w-4" /> Bulk import CSV / Excel
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--swift-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or SKU"
            className="w-64 rounded-lg border border-black/10 bg-white py-2 pl-9 pr-3 text-sm"
          />
        </div>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <option value="">All categories</option>
          {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="h-4 w-4 accent-[var(--swift-red)]" />
          Low stock only
        </label>
        <span className="text-sm text-[var(--swift-muted)]">{list.length} items</span>
      </div>

      <div className="overflow-hidden rounded-2xl border border-black/5 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-black/5 bg-[var(--swift-subtle)] text-left text-xs uppercase tracking-wide text-[var(--swift-muted)]">
            <tr>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Stock</th>
              <th className="px-4 py-3">Live</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {items.isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--swift-muted)]">Loading…</td></tr>
            )}
            {!items.isLoading && list.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--swift-muted)]">No items match.</td></tr>
            )}
            {list.map((i) => {
              const low = i.stockQuantity != null && i.stockQuantity <= (i.lowStockThreshold ?? 5);
              return (
                <>
                  <tr key={i.id} className="border-b border-black/5 last:border-0">
                    <td className="px-4 py-3 font-medium">{i.name}</td>
                    <td className="px-4 py-3 text-[var(--swift-muted)]">{i.category?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-[var(--swift-muted)]">{i.sku ?? '—'}</td>
                    <td className="px-4 py-3">
                      {editingPrice === i.id ? (
                        <PriceEdit item={i} onDone={() => { setEditingPrice(null); refresh(); }} />
                      ) : (
                        <button onClick={() => setEditingPrice(i.id)} className="font-medium hover:text-[var(--swift-red)] hover:underline">
                          {money(i.basePrice)}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {i.stockQuantity == null ? (
                        <span className="text-[var(--swift-muted)]">untracked</span>
                      ) : (
                        <button
                          onClick={() => setAdjusting(adjusting === i.id ? null : i.id)}
                          className={`font-bold hover:underline ${low ? 'text-amber-600' : ''}`}
                        >
                          {i.stockQuantity}{low ? ' ⚠' : ''}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => availMut.mutate({ id: i.id, isAvailable: !i.isAvailable })}
                        disabled={availMut.isPending}
                        className={`relative h-5 w-9 rounded-full transition-colors ${i.isAvailable ? 'bg-green-500' : 'bg-black/15'}`}
                        title={i.isAvailable ? 'Live — customers can order it' : 'Hidden / sold out'}
                      >
                        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${i.isAvailable ? 'left-[18px]' : 'left-0.5'}`} />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      {i.stockQuantity != null && (
                        <button
                          onClick={() => setAdjusting(adjusting === i.id ? null : i.id)}
                          className="text-xs font-semibold text-[var(--swift-red)] hover:underline"
                        >
                          Adjust stock
                        </button>
                      )}
                    </td>
                  </tr>
                  {adjusting === i.id && (
                    <tr key={`${i.id}-adjust`}>
                      <td colSpan={7} className="px-4 pb-3">
                        <StockAdjust item={i} onDone={() => { setAdjusting(null); refresh(); }} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--swift-muted)]">
        Photos, descriptions, options and new single items are managed in the Swift app — this table is built for fast
        price / stock / availability work on a big screen.
      </p>
    </div>
  );
}
