'use client';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { MutationError } from '@/components/MutationError';
import { revokeDoc } from '@/lib/api';
import { reasonTooShort } from '@/lib/ask-reason';
import type { ReviewDocument } from '@/lib/review-center';

/**
 * [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID] A customer's ID goes on file at once unless the
 * server's automatic checks hold it for a person; an admin can withdraw it at any time (back to L1).
 * This panel says plainly which kind of ID a reviewer is looking at — "on file" is not "reviewed" —
 * and carries the withdrawal. Partner, driver and rider documents never show it.
 */
export const CUSTOMER_ID_DOC_TYPE = 'identity_l2';
/** The reviewedBy markers the server writes when no person decided (customer-id.ts ON_FILE_REVIEWER; the processor). */
const AUTOMATIC_REVIEWERS: ReadonlySet<string> = new Set(['auto:id-on-file', 'kyc:auto']);

export function customerIdFact(doc: Pick<ReviewDocument, 'docType' | 'status' | 'reviewedBy'>): string | null {
  if (doc.docType !== CUSTOMER_ID_DOC_TYPE) return null;
  if (doc.status === 'APPROVED') {
    return AUTOMATIC_REVIEWERS.has(doc.reviewedBy ?? '')
      ? 'On file — the automatic checks found nothing to hold. No person has reviewed this ID.'
      : 'On file — approved by a reviewer.';
  }
  if (doc.status === 'PENDING') return 'Held for a person by the automatic checks — the history below says why. Approving it unlocks taxi rides and big orders.';
  return null;
}

export function CustomerIdOnFile({ doc, onWithdrawn }: { doc: ReviewDocument; onWithdrawn: (_withdrawn: ReviewDocument) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const withdraw = useMutation({
    mutationFn: () => revokeDoc(doc.id, reason.trim()),
    onSuccess: async () => { setOpen(false); setReason(''); await onWithdrawn(doc); },
  });
  const fact = customerIdFact(doc);
  if (!fact) return null;
  const busy = withdraw.isPending;
  return <div className="rc-customer-id">
    <p>{fact}</p>
    {doc.status === 'APPROVED' && <button disabled={busy} onClick={() => { setReason(''); withdraw.reset(); setOpen(true); }}>Withdraw this ID (back to L1)</button>}
    {open && <Modal title="Withdraw customer ID" busy={busy} onClose={() => setOpen(false)}>
      <h2>Withdraw this customer ID</h2>
      <p>The account goes back to L1 at once: taxi rides and orders over the ID limit lock again, and the next ID they send waits for a person.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (busy || reasonTooShort(reason) || reason.trim().length > 500) return;
        withdraw.mutate();
      }}>
        <label>Why it is withdrawn<textarea aria-label="Why it is withdrawn" rows={4} maxLength={500} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>
        <p className="rc-muted">At least 12 characters. Kept in the review record; the customer is told only that the ID was withdrawn.</p>
        <MutationError error={withdraw.error} label="Withdrawal failed" />
        <div className="rc-dialog-actions">
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button className="rc-primary" type="submit" disabled={busy || reasonTooShort(reason)}>{busy ? 'Withdrawing…' : 'Confirm withdrawal'}</button>
        </div>
      </form>
    </Modal>}
  </div>;
}
