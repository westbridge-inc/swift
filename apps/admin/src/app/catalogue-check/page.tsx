'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approveCatalogueItem,
  fetchCatalogueReview,
  PROHIBITED_CLASSES,
  removeCatalogueItem,
  type ProhibitedClass,
} from '@/lib/api';
import type { Outcome } from '@/lib/outcome';
import { JUDGED_FIELD_WORDS as FIELD_WORDS, PROHIBITED_CLASS_LABELS as CLASS_LABELS } from '@/lib/prohibited-items';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';

// ---------------------------------------------------------------------------
// [GUARDRAILS §8] THE CATALOGUE CHECK (owner, 13 Oct 2026).
//
// Swift never carries alcohol, tobacco, vapes, 18+ items, medicines, cooking
// gas or fuel. A banned platform category is refused outright; a banned WORD
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
        It is banned for good as {CLASS_LABELS[removeAs]}: hidden everywhere, and the partner cannot edit it back. The
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
        Held as <strong>{CLASS_LABELS[item.prohibitedClass]}</strong>: the word &ldquo;{item.term}&rdquo; in the{' '}
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

  const done = (outcome: Outcome | null) => {
    if (!outcome) return;
    setResult(outcome);
    void qc.invalidateQueries({ queryKey: ['catalogue-review'] });
  };

  return (
    <div className="mc-page">
      <h1 className="text-2xl font-bold mb-2">Catalogue check</h1>
      <p className="mc-muted mb-4 text-sm">
        Swift never carries alcohol, tobacco, vapes, 18+ items, medicines, cooking gas or fuel. These items were saved
        with one of those words in the partner&apos;s own text, so customers cannot see or order them until you check.
        Approve shows an item exactly as written; remove bans it for good. Neither can lift a ban on a category.
      </p>
      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-5" />
      {queue.isLoading ? (
        <div className="mc-card" aria-busy="true">Loading the check…</div>
      ) : queue.isError ? (
        <QueryFailed error={queue.error} what="the catalogue check" onRetry={() => void queue.refetch()} retrying={queue.isFetching} />
      ) : items.length === 0 ? (
        <div className="mc-card">Nothing waiting for a check.</div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => <Row key={item.itemId} item={item} onDone={done} />)}
        </ul>
      )}
    </div>
  );
}
