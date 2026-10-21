// [UI-SWEEP U14 / U17] The phone's words for an order, one copy: the status
// label by the order's own vertical, and the notice after a reorder that could
// not bring every line back. Pure, types-only imports (pattern: lib/app-rules.ts).
// Only the order pages import this module.
import type { OrderVerticalFacts } from '@swift/types';
import { presentedVertical as phonePresentedVertical } from '../../../mobile/src/lib/orderStatus';

export { orderStatusLabel } from '../../../mobile/src/lib/orderStatus';
/** The web's order types carry `orderType` as a plain string; the phone's reader
 *  already maps a declaration it does not recognise to UNKNOWN, so the wider input is safe. */
export const presentedVertical = (order: { vertical?: string | null; orderType?: string | null }) =>
  phonePresentedVertical(order as OrderVerticalFacts);
export { reorderNotice } from '../../../mobile/src/lib/reorderNotice';
