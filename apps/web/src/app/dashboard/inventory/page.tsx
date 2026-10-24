'use client';

import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Search } from 'lucide-react';
import { adjustStock, getCategories, getItems, money, setItemAvailability, updateItem, type CatalogItem } from '@/lib/vendor-api';
import { Pictogram } from '@/components/glyphs';
import { DataUnavailable } from '@/components/data-unavailable';
import { MutationNotice } from '@/components/mutation-notice';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useCatalogueName } from '@/lib/catalogue-name';
import { instantSwitch } from '@/lib/instant-toggle';

type AdjustReason = 'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN';

function StockAdjust({ item, onDone }: { item: CatalogItem; onDone: () => void }) {
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState<AdjustReason>('RECEIVED');
  const [error, setError] = useState<string | null>(null);
  // [MASTER-025] One key per adjustment as entered: retrying the same entry
  // after a failure cannot move stock twice; changing it is a new adjustment.
  const [commandKey, setCommandKey] = useState(() => crypto.randomUUID());
  const mut = useMutation({
    mutationFn: () => adjustStock(item.id, delta, reason, undefined, commandKey),
    onSuccess: () => { setCommandKey(crypto.randomUUID()); onDone(); },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--swift-subtle)] p-3">
      <span className="text-sm font-semibold">{item.name}</span>
      <input
        type="number"
        value={delta || ''}
        onChange={(e) => { setDelta(Number(e.target.value)); setCommandKey(crypto.randomUUID()); }}
        placeholder="+/- qty"
        className="w-24 rounded-lg border border-[var(--swift-border)] px-2 py-1.5 text-sm"
      />
      <select
        value={reason}
        onChange={(e) => { setReason(e.target.value as AdjustReason); setCommandKey(crypto.randomUUID()); }}
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

/**
 * [SPEED 22 Oct] One item's row. Memoised: an in-stock tap, a background re-read or a key
 * typed in Search draws again only a row whose own facts changed (the read keeps unchanged
 * items as the same objects), not every row of the catalogue. Off-screen rows also skip
 * layout and paint until scrolled to (content-visibility), which long catalogues need.
 */
const ItemRow = memo(function ItemRow({ item: i, pending, adjusting, editingPrice, onToggle, onAdjust, onEditPrice, onSaved }: {
  item: CatalogItem;
  pending: boolean;
  adjusting: boolean;
  editingPrice: boolean;
  onToggle: (_id: string, _isAvailable: boolean) => void;
  onAdjust: (_id: string | null) => void;
  onEditPrice: (_id: string | null) => void;
  onSaved: () => void;
}) {
  const low = i.stockQuantity != null && i.stockQuantity <= (i.lowStockThreshold ?? 5);
  return <article aria-label={i.name} className="border-b border-[var(--swift-border)] py-5" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}>
    <div className="flex items-center gap-3">
      <span className="grid h-12 w-12 flex-none place-items-center rounded-xl bg-[var(--swift-sunken)]"><Pictogram name="food" size={26} /></span>
      <div className={`min-w-0 flex-1 ${i.isAvailable ? '' : 'opacity-60'}`}><h2 className="sw-label">{i.name}</h2><p className="sw-caption">{i.category?.name ?? 'Uncategorised'}</p>
        {i.catalogueCheck && <CatalogueCheckNote check={i.catalogueCheck} />}
        {editingPrice ? <PriceEdit item={i} onDone={() => { onEditPrice(null); onSaved(); }} /> : <button onClick={() => onEditPrice(i.id)} className="min-h-8 font-semibold hover:underline">{money(i.basePrice)}</button>}
      </div>
      <button role="switch" aria-label={`In stock: ${i.name}`} aria-checked={i.isAvailable} onClick={() => onToggle(i.id, !i.isAvailable)} disabled={pending}
        className="grid h-11 w-16 flex-none place-items-center disabled:opacity-60" title={i.isAvailable ? 'Live — customers can order it' : 'Hidden / sold out'}>
        <span className={`sw-stock-switch ${i.isAvailable ? 'bg-[var(--swift-red)]' : 'bg-[var(--swift-border-strong)]'}`}><span className={`sw-stock-knob ${i.isAvailable ? 'translate-x-5' : ''}`} /></span>
      </button>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-[var(--swift-muted)]">
      {!i.isAvailable && <span>Sold out</span>}
      {low && <span className="font-semibold text-amber-700">Low stock</span>}
      {i.stockQuantity == null ? <span>Stock untracked</span> : <button onClick={() => onAdjust(adjusting ? null : i.id)} className="sw-link-btn min-h-8">{i.stockQuantity} in stock · Adjust stock</button>}
      {i.sku && <span>SKU: {i.sku}</span>}
    </div>
    {adjusting && <StockAdjust item={i} onDone={() => { onAdjust(null); onSaved(); }} />}
  </article>;
});

export default function InventoryPage() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const catalogue = useCatalogueName();

  const items = useQuery({ queryKey: storeKey(storeId, 'items', 'all'), queryFn: () => getItems() });
  const categories = useQuery({ queryKey: storeKey(storeId, 'categories'), queryFn: getCategories });

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'items') }), [queryClient, storeId]);
  // [PERF row 562] An item's in-stock switch moves at the tap and goes back if the server refuses.
  // Only that item's switch waits for its answer: the others stay usable (they used to lock together).
  const availKey = ['item-availability', storeId];
  const availMut = useMutation({
    mutationKey: availKey,
    mutationFn: (v: { id: string; isAvailable: boolean }) => setItemAvailability(v.id, v.isAvailable),
    ...instantSwitch<{ id: string; isAvailable: boolean }, CatalogItem[]>(
      queryClient, storeKey(storeId, 'items', 'all'),
      (rows, v, undo) => rows.map((row) => (row.id === v.id ? { ...row, isAvailable: undo ? !v.isAvailable : v.isAvailable } : row)),
      // [#1936 S4-1] Only the last answer re-reads: a re-read while another item's change is
      // still on its way would show that item's old value for a moment. (This one still counts.)
      () => (queryClient.isMutating({ mutationKey: availKey }) > 1 ? undefined : refresh()),
    ),
  });
  const availPending = new Set(useMutationState({
    filters: { mutationKey: availKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as { id: string } | undefined)?.id,
  }));

  const soldOutCount = (items.data ?? []).filter((i) => i.isAvailable === false).length;
  const activeCount = Math.max(0, (items.data ?? []).length - soldOutCount);

  // [SPEED 22 Oct] The search box answers each key at once; the list follows a moment later.
  const shownSearch = useDeferredValue(search);
  const list = useMemo(() => {
    let rows = items.data ?? [];
    const term = shownSearch.toLowerCase();
    if (term) rows = rows.filter((i) => i.name.toLowerCase().includes(term) || (i.sku ?? '').toLowerCase().includes(term));
    if (categoryId) rows = rows.filter((i) => i.category?.id === categoryId);
    if (lowOnly) rows = rows.filter((i) => i.stockQuantity != null && i.stockQuantity <= (i.lowStockThreshold ?? 5));
    return rows;
  }, [items.data, shownSearch, categoryId, lowOnly]);
  const toggle = availMut.mutate;
  const onToggle = useCallback((id: string, isAvailable: boolean) => toggle({ id, isAvailable }), [toggle]);

  return (
    <div className="space-y-5">
      <MutationNotice errors={[availMut.error]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {/* As in the app (VendorMenuScreen): the store type's name, then "Your menu" with live and sold-out counts. */}
          <h1 className="sw-title">{catalogue}</h1>
          <p className="sw-caption mt-1"><span className="font-semibold uppercase tracking-wide">Your menu</span>{items.data && <> · <span>{activeCount} active · {soldOutCount} sold out</span></>}</p>
        </div>
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
        {list.map(i => <ItemRow key={i.id} item={i} pending={availPending.has(i.id)} adjusting={adjusting === i.id} editingPrice={editingPrice === i.id}
          onToggle={onToggle} onAdjust={setAdjusting} onEditPrice={setEditingPrice} onSaved={refresh} />)}
      </div>
      <p className="text-xs text-[var(--swift-muted)]">
        Photos, descriptions, options and new single items are managed in the Swift app — you can edit prices, stock and availability here.
      </p>
    </div>
  );
}

/** [GUARDRAILS §8] Why customers cannot see this item: Swift does not allow it, or a person is checking it. */
function CatalogueCheckNote({ check }: { check: NonNullable<CatalogItem['catalogueCheck']> }) {
  const reason = check.status === 'NOT_ALLOWED' && check.reason ? ` Reason: ${check.reason}` : '';
  return (
    <p role="status" className={`text-[13px] font-semibold ${check.status === 'NOT_ALLOWED' ? 'text-[var(--swift-red)]' : 'text-amber-700'}`}>
      {check.message}{check.status === 'WAITING_FOR_CHECK' ? ' — hidden from customers until Swift checks it.' : ''}{reason}
    </p>
  );
}
