'use client';

import Link from 'next/link';
import { checkoutReferences, checkoutSeller, checkoutWords, feeDate, feeMoney, type CheckoutView, type FeeSubscription } from '@/lib/weekly-fee';

/**
 * [PERF · 6 Nov 2026] The weekly-fee page's lower half: recent checkouts (each with the references support finds it by
 * and its seller), the refunds promise, and the receipts. It sits below the fold, so the page loads it in its own chunk,
 * off the first load (perf budget). Same words and reads as before (weekly-fee.tsx).
 */
export default function WeeklyFeeHistory({ sub, view }: { sub: FeeSubscription; view: CheckoutView }) {
  return <>
      <h2 className="text-lg font-bold">Recent checkouts</h2>
      {sub.recentCheckouts?.length ? sub.recentCheckouts.map((c) => {
        const shown = c.ref === view.checkout?.ref ? view.checkout : c;
        return <div key={c.ref} className="space-y-2 rounded-2xl border border-black/5 bg-white p-5">
          <p className="text-sm text-[var(--swift-muted)]">{feeDate(c.createdAt)} · {feeMoney(c.amountGyd)}</p>
          <p>{checkoutWords(shown, c.ref === view.checkout?.ref && view.returned)}</p>
          {/* The references support finds this payment by: ours always, MMG's once confirmed. */}
          {checkoutReferences(shown).map((r) => <p key={r.label} className="text-sm text-[var(--swift-muted)]">{r.label}: <span className="font-mono">{r.value}</span></p>)}
          {/* [Owner 15 Oct 2026 · ruling #63] who sold the weekly fee, as the API states it */}
          {checkoutSeller(shown) ? <p className="text-sm text-[var(--swift-muted)]" data-testid="fee-seller">{checkoutSeller(shown)}</p> : null}
        </div>;
      }) : <p className="text-sm text-[var(--swift-muted)]">No recent checkouts.</p>}
      {/* [Row 156] The refunds page's own promise, word for word: no new promise, and no time for MMG's part. */}
      <p className="text-sm text-[var(--swift-muted)]">Charged twice, or by mistake? Tell support and Swift refunds the extra or mistaken charge in full, within 14 days, to the method you paid with. <Link href="/legal/refunds" className="underline">How refunds work</Link></p>
      <h2 className="text-lg font-bold">Receipts</h2>
      {/* [owner legal plan R12] Printed by the API, line by line: the same receipt support and the accountant see. */}
      {sub.feeReceipts?.length ? sub.feeReceipts.map((r) => <div key={r.receiptNumber} aria-label={`Receipt ${r.receiptNumber}`} className="space-y-1 rounded-2xl border border-black/5 bg-white p-5 text-sm">
        {r.lines.map((line, i) => <p key={i} className={i === 0 ? 'font-semibold' : undefined}>{line}</p>)}
      </div>) : <p className="text-sm text-[var(--swift-muted)]">No receipts yet.</p>}
  </>;
}
