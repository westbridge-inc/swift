'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveCatalogueItem,
  approveCatalogueStore,
  fetchCatalogueReview,
  PROHIBITED_CLASSES,
  removeCatalogueItem,
  suspendVendor,
  type ProhibitedClass,
} from '@/lib/api';
import type { Outcome } from '@/lib/outcome';
import { JUDGED_FIELD_WORDS as FIELD_WORDS, PROHIBITED_CLASS_LABELS as CLASS_LABELS, STORE_FIELD_WORDS } from '@/lib/prohibited-items';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { label } from '@/lib/labels';

// ---------------------------------------------------------------------------
// [GUARDRAILS §8] THE CATALOGUE CHECK (owner, 13 Oct 2026).
//
// Swift never carries alcohol, tobacco, vapes, 18+ items, medicines, cooking
// gas or fuel — nor, since 15 Oct (R4), explosives, pesticides, raw gold and
// stones, firearms, protected wildlife, counterfeits, currency and payment
// cards, or legal services. A banned platform category is refused outright; a banned WORD
// in a partner's own text saves the item but holds it hidden until a person
// looks — and this is where that person looks.
//
//   Approve — shows the item for exactly the words on screen. The approval
//             carries the fingerprint of those words; if the partner edited the
//             item meanwhile the server refuses it, and any later edit brings
//             the item back here.
//   Remove  — bans the item for good. The partner reads the reason.
//
// Nothing here lifts a ban on a category or an earlier removal.
//
// [owner 14 Oct] A STORE whose own name, description or tags mention those
// goods ("X Liquor Store", "Rum Shop", a pharmacy) is held too, with every item
// it sells. Approve shows the store for exactly the words on screen (a rename
// brings it back here); a store that sells banned goods is suspended instead.
// ---------------------------------------------------------------------------

interface WaitingItem {
  itemId: string;
  vendor: { id: string; name: string };
  name: string;
  description: string | null;
  sectionName: string | null;
  optionNames: string[];
  prohibitedClass: ProhibitedClass;
  field: string;
  term: string;
  wordsHash: string;
}

interface WaitingStore {
  vendorId: string;
  name: string;
  description: string | null;
  tags: string[];
  status: string;
  prohibitedClass: ProhibitedClass;
  field: string;
  term: string;
  wordsHash: string;
}

function StoreRow({ store, onDone }: { store: WaitingStore; onDone: (_outcome: Outcome | null) => void }) {
  const dialog = useActionDialog();

  const approve = async () => onDone(await dialog.run({
    title: `Approve ${store.name}?`,
    body: (
      <p>
        Customers can see this store and its items, exactly as it is named and described here. If the partner changes
        the store&apos;s name, description or tags, it comes back to this check. Each item is still checked by its own words.
      </p>
    ),
    confirmLabel: 'Approve store',
    reason: { hint: 'Kept on the permanent record; not sent to the partner.' },
    submit: ({ reason }) => approveCatalogueStore(store.vendorId, store.wordsHash, reason),
    success: () => `${store.name} is approved and visible.`,
  }));

  const suspend = async () => onDone(await dialog.run({
    title: `Suspend ${store.name}?`,
    body: <p>The store stops trading at once and its owner reads your reason. Use this when the store sells goods Swift doesn&apos;t carry.</p>,
    confirmLabel: 'Suspend store',
    reason: { hint: 'The owner reads this reason, and it is kept on the permanent record.' },
    submit: ({ reason }) => suspendVendor(store.vendorId, reason),
    success: () => `${store.name} is suspended.`,
  }));

  return (
    <li className="mc-card" aria-label={store.name}>
      <p className="mc-label">Store · {label('VendorStatus', store.status)}</p>
      <h2 className="text-base font-semibold">{store.name}</h2>
      <p className="text-sm">
        Held as <strong>{CLASS_LABELS[store.prohibitedClass] ?? 'goods Swift does not allow'}</strong>: the word &ldquo;{store.term}&rdquo; in the{' '}
        {STORE_FIELD_WORDS[store.field] ?? store.field}. Its items are hidden with it.
      </p>
      <dl className="mc-rows">
        {store.description ? <div className="mc-row"><dt>Description</dt><dd>{store.description}</dd></div> : null}
        {store.tags.length ? <div className="mc-row"><dt>Tags</dt><dd>{store.tags.join(', ')}</dd></div> : null}
      </dl>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" className="mc-btn mc-btn-primary" onClick={() => void approve()}>Approve store…</button>
        {store.status !== 'SUSPENDED' ? (
          <button type="button" className="mc-btn mc-btn-danger" onClick={() => void suspend()}>Suspend store…</button>
        ) : null}
      </div>
    </li>
  );
}

function Row({ item, onDone }: { item: WaitingItem; onDone: (_outcome: Outcome | null) => void }) {
  const dialog = useActionDialog();
  const [removeAs, setRemoveAs] = useState<ProhibitedClass>(item.prohibitedClass);

  const approve = async () => onDone(await dialog.run({
    title: `Approve ${item.name}?`,
    body: (
      <p>
        Customers can see and order it, exactly as written here. If the partner changes its words, it comes back to this
        check.
      </p>
    ),
    confirmLabel: 'Approve item',
    reason: { hint: 'Kept on the permanent record; not sent to the partner.' },
    submit: ({ reason }) => approveCatalogueItem(item.itemId, item.wordsHash, reason),
    success: () => `${item.name} is approved and visible.`,
  }));

  const remove = async () => onDone(await dialog.run({
    title: `Remove ${item.name}?`,
    body: (
      <p>
        It is banned for good as {CLASS_LABELS[removeAs] ?? removeAs}: hidden everywhere, and the partner cannot edit it back. The
        partner reads your reason.
      </p>
    ),
    confirmLabel: 'Remove item',
    reason: { hint: 'The partner reads this reason, and it is kept on the permanent record.' },
    submit: ({ reason }) => removeCatalogueItem(item.itemId, removeAs, reason),
    success: () => `${item.name} is removed from Swift.`,
  }));

  return (
    <li className="mc-card" aria-label={item.name}>
      <p className="mc-label">{item.vendor.name}</p>
      <h2 className="text-base font-semibold">{item.name}</h2>
      <p className="text-sm">
        Held as <strong>{CLASS_LABELS[item.prohibitedClass] ?? 'goods Swift does not allow'}</strong>: the word &ldquo;{item.term}&rdquo; in the{' '}
        {FIELD_WORDS[item.field] ?? item.field}.
      </p>
      <dl className="mc-rows">
        {item.sectionName ? <div className="mc-row"><dt>Menu section</dt><dd>{item.sectionName}</dd></div> : null}
        {item.description ? <div className="mc-row"><dt>Description</dt><dd>{item.description}</dd></div> : null}
        {item.optionNames.length ? <div className="mc-row"><dt>Options</dt><dd>{item.optionNames.join(', ')}</dd></div> : null}
      </dl>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" className="mc-btn mc-btn-primary" onClick={() => void approve()}>Approve…</button>
        <label className="text-xs">
          Remove as{' '}
          <select value={removeAs} onChange={(e) => setRemoveAs(e.target.value as ProhibitedClass)} aria-label="Remove as">
            {PROHIBITED_CLASSES.map((c) => <option key={c} value={c}>{CLASS_LABELS[c]}</option>)}
          </select>
        </label>
        <button type="button" className="mc-btn mc-btn-danger" onClick={() => void remove()}>Remove…</button>
      </div>
    </li>
  );
}

export default function CatalogueCheckPage() {
  const qc = useQueryClient();
  const [result, setResult] = useState<Outcome | null>(null);
  const queue = useQuery({ queryKey: ['catalogue-review'], queryFn: () => fetchCatalogueReview() });
  const items: WaitingItem[] = queue.data?.data?.items ?? [];
  const total: number = queue.data?.data?.total ?? items.length;
  const stores: WaitingStore[] = queue.data?.data?.stores ?? [];
  const storesTotal: number = queue.data?.data?.storesTotal ?? stores.length;

  const done = (outcome: Outcome | null) => {
    if (!outcome) return;
    setResult(outcome);
    void qc.invalidateQueries({ queryKey: ['catalogue-review'] });
  };

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4 text-sm">
        Swift never carries alcohol, tobacco, vapes, cannabis or other drugs, 18+ items, medicines, cooking gas, fuel,
        fireworks or explosives, pesticides or toxic chemicals, raw gold, diamonds or precious stones, firearms,
        ammunition or replicas, protected wildlife, counterfeit goods, currency or payment cards, and never lists legal
        services. These items were saved with one of those words in the partner&apos;s own text, so customers cannot see or order them until you check.
        Approve shows an item exactly as written; remove bans it for good. Neither can lift a ban on a category. A store
        whose own name, description or tags mention those goods is held too, with all its items, until you approve it or
        suspend it.
      </p>
      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-5" />
      {queue.isLoading ? (
        <div className="mc-card" aria-busy="true">Loading the check…</div>
      ) : queue.isError ? (
        <QueryFailed error={queue.error} what="the catalogue check" onRetry={() => void queue.refetch()} retrying={queue.isFetching} />
      ) : items.length === 0 && stores.length === 0 ? (
        <div className="mc-card">Nothing waiting for a check.</div>
      ) : (
        <>
          {stores.length > 0 ? (
            <section aria-label="Stores waiting" className="mb-5">
              <h2 className="text-lg font-semibold mb-2">Stores</h2>
              {storesTotal > stores.length ? (
                <p className="mc-muted mb-3 text-sm">Showing the first {stores.length} of {storesTotal} stores waiting.</p>
              ) : null}
              <ul className="space-y-3">
                {stores.map((store) => <StoreRow key={store.vendorId} store={store} onDone={done} />)}
              </ul>
            </section>
          ) : null}
          {items.length > 0 && stores.length > 0 ? <h2 className="text-lg font-semibold mb-2">Items</h2> : null}
          {total > items.length ? (
            <p className="mc-muted mb-3 text-sm">Showing the first {items.length} of {total} items waiting. Check these, then reload for the rest.</p>
          ) : null}
          <ul className="space-y-3">
            {items.map((item) => <Row key={item.itemId} item={item} onDone={done} />)}
          </ul>
        </>
      )}
    </div>
  );
}
