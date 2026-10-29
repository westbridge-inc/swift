'use client';

import { useState } from 'react';
import type { Store } from '@/lib/vendor-api';
import { copyMenu, type MenuCopyResult } from '@/lib/branches-api';
import { copyResultWords, newCopyKey } from '@/lib/branches';

/**
 * [CHAINS PR2 · owner 29 Oct 2026] An empty branch menu can start as a copy of another branch's: its sections,
 * items, options, prices and photos (POST /vendor/menu/copy). Stock is per branch. The copy's key is kept until it
 * succeeds, so a retry after a dropped answer is the same copy, never a second one. Loaded only for an empty menu
 * of a business with more than one store.
 */
export default function BranchMenuCopy({ storeId, stores, onCopied }: { storeId: string; stores: Store[]; onCopied: () => void }) {
  // [REVIEW-F #2220 N2] Any other branch of the business, live or not yet (the phone offers the same; the server
  // decides who may copy from where).
  const sources = stores.filter((s) => s.id !== storeId);
  const [from, setFrom] = useState(sources[0]?.id ?? '');
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MenuCopyResult | null>(null);
  if (sources.length === 0) return null;
  const source = sources.find((s) => s.id === from);

  const copy = async () => {
    if (!from || busy) return;
    const copyKey = key ?? newCopyKey();
    setKey(copyKey);
    setBusy(true);
    setError(null);
    try {
      const r = await copyMenu(from, copyKey);
      setResult(r);
      setKey(null);
      onCopied();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'The menu wasn’t copied. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <section aria-labelledby="menu-copied" className="sw-card space-y-1 p-5">
        <h2 id="menu-copied" className="text-base font-bold">Menu copied</h2>
        {copyResultWords(result).map((line) => <p key={line} className="text-sm">{line}</p>)}
      </section>
    );
  }
  return (
    <section aria-labelledby="menu-copy" className="sw-card space-y-3 p-5">
      <h2 id="menu-copy" className="text-base font-bold">Copy the menu from another branch</h2>
      <p className="text-sm text-[var(--swift-muted)]">Its sections, items, options, prices and photos come here. Stock counts stay per branch. You can change anything after.</p>
      <label className="block text-sm font-semibold">Copy from
        <select className="mt-1 w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-2 text-sm" value={from}
          onChange={(e) => { setFrom(e.target.value); setKey(null); setError(null); }}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{error}</p>}
      <button type="button" className="sw-btn sw-btn-md" disabled={!from || busy} onClick={() => void copy()}>
        {busy ? 'Copying…' : `Copy ${source?.name ?? 'that branch'}’s menu here`}
      </button>
    </section>
  );
}
