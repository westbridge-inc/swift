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
    if (AUTOMATIC_REVIEWERS.has(doc.reviewedBy ?? '')) return 'On file — the automatic checks found nothing to hold. No person has reviewed this ID.';
    // A reviewer is named only when the row names one; an older row without it claims nothing.
    return doc.reviewedBy ? 'On file — approved by a reviewer.' : 'On file.';
  }
  if (doc.status === 'PENDING') return 'Held for a person by the automatic checks — the history below says why. Approving it unlocks big orders and taxi rides.';
  return null;
}

/**
 * The page's line after a withdrawal, from the SERVER's answer only: "back to L1" is said when the
 * server reports L1, never assumed (a server without that answer, or another ID still standing).
 */
export function withdrawNotice(name: string, accountTrustLevel: unknown): string {
  if (accountTrustLevel === 'L1') return `Withdrew the customer ID for ${name}. The account is back to L1.`;
  if (typeof accountTrustLevel === 'string') return `Withdrew the customer ID for ${name}. The account is still at ${accountTrustLevel}: another ID stands.`;
  return `Withdrew the customer ID for ${name}. The server did not report the account level — check it on the user page before relying on it.`;
}

export function CustomerIdOnFile({ doc, onWithdrawn }: { doc: ReviewDocument; onWithdrawn: (_withdrawn: ReviewDocument, _accountTrustLevel: unknown) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const withdraw = useMutation({
    mutationFn: () => revokeDoc(doc.id, reason.trim()),
    onSuccess: async (result: { data?: { accountTrustLevel?: unknown } } | undefined) => { setOpen(false); setReason(''); await onWithdrawn(doc, result?.data?.accountTrustLevel); },
  });
  const fact = customerIdFact(doc);
  if (!fact) return null;
  const busy = withdraw.isPending;
  return <div className="rc-customer-id">
    <p>{fact}</p>
    {doc.status === 'APPROVED' && <button disabled={busy} onClick={() => { setReason(''); withdraw.reset(); setOpen(true); }}>Withdraw this ID</button>}
    {open && <Modal title="Withdraw customer ID" busy={busy} onClose={() => setOpen(false)}>
      <h2>Withdraw this customer ID</h2>
      <p>With no other ID standing, the account goes back to L1: taxi rides and orders over the ID limit lock again, and the next ID they send waits for a person. The page shows the account level the server reports after you confirm.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (busy || reasonTooShort(reason) || reason.trim().length > 500) return;
        withdraw.mutate();
      }}>
        <label>Why it is withdrawn<textarea aria-label="Why it is withdrawn" rows={4} maxLength={500} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>
        <p className="rc-muted">At least 12 characters. Kept in the staff record; the customer&apos;s app shows only that our team withdrew it.</p>
        <MutationError error={withdraw.error} label="Withdrawal failed" />
        <div className="rc-dialog-actions">
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button className="rc-primary" type="submit" disabled={busy || reasonTooShort(reason)}>{busy ? 'Withdrawing…' : 'Confirm withdrawal'}</button>
        </div>
      </form>
    </Modal>}
  </div>;
}
