// [UI-SWEEP U14 / U17] The phone's words for an order, one copy: the status
// label by the order's own vertical, and the notice after a reorder that could
// not bring every line back. Pure, types-only imports (pattern: lib/app-rules.ts).
// Only the order pages import this module.
export { orderStatusLabel, presentedVertical } from '../../../mobile/src/lib/orderStatus';
export { reorderNotice } from '../../../mobile/src/lib/reorderNotice';
