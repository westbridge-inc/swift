import type { ConsentDocumentType } from '../legal/consent.service';
import { PRO_AGREEMENT_VERSION } from '../legal/reaccept';

/** [BOOK-P3 · COORD 29 Oct 2026 16:13Z] The agreement a pro must have accepted before customers book them from
 *  their list of services, and the first LEGAL_VERSION of it that carries the advance-acceptance clause
 *  (pro-menu-agreement.ts). Null = no version carries the clause yet, so no pro is bookable from a list
 *  (fail-closed). BILL-PRO sets `sinceVersion` in the PR that adds the clause to the pro agreement.
 *  [BILL-PRO PR7] That PR is this one: the Business Agreement's section 12 (PRO_AGREEMENT_VERSION, legal/reaccept.ts)
 *  carries the clause, so a pro is bookable from their list once they accepted that version or later. */
export const PRO_MENU_AGREEMENT: { readonly documentType: ConsentDocumentType; readonly sinceVersion: string | null } = {
  documentType: 'vendor_agreement',
  sinceVersion: PRO_AGREEMENT_VERSION,
};
