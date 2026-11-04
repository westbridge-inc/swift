'use client';
import type { ReviewDocument } from '@/lib/review-center';

/**
 * [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (b)] Swift no longer keeps customer IDs. A customer ID still in front of a
 * reviewer (one filed before the ruling, before the daily sweep withdraws and deletes it, or one a legal or safety hold
 * keeps) has nothing to decide: approving it is refused by the server, and the sweep withdraws it on its own. This note
 * says so in place of the old on-file panel and its withdraw button. Every other document shows nothing.
 */
export const CUSTOMER_ID_DOC_TYPE = 'identity_l2';

export function customerIdRetiredNote(doc: Pick<ReviewDocument, 'docType'>): string | null {
  if (doc.docType !== CUSTOMER_ID_DOC_TYPE) return null;
  return 'Swift no longer keeps customer IDs, so there is nothing to decide here. The daily sweep withdraws this ID and deletes it; a legal or safety hold keeps it until the hold ends.';
}

export function CustomerIdRetired({ doc }: { doc: Pick<ReviewDocument, 'docType'> }) {
  const note = customerIdRetiredNote(doc);
  if (!note) return null;
  return <p role="note" className="rc-customer-id">{note}</p>;
}
