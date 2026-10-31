/**
 * [owner 30 Oct 2026] The LIFECYCLE_V2 order hold: how long a new order stays with its customer — free to cancel,
 * hidden from the store, not dispatched — before it is released. ONE minute for every store order, delivery and
 * pickup alike (owner, testing a pickup on staging: "the 5 minute wait time is still there, not 1 minute"); a
 * courier parcel is held by the same window (courier.routes.ts). Was five minutes (Total Audit build order).
 *
 * The deploy sets it with one line, ORDER_HOLD_MINUTES; unset reads as this default. Production refuses a value
 * that is not a number or is shorter than ORDER_HOLD_FLOOR_MIN (utils/boot-config.ts). Express orders and
 * bookings are never held (order.service.ts). Every client counts down from the server's own holdExpiresAt.
 * A leaf (no imports) so the hold readers and their tests share one number.
 */
export const ORDER_HOLD_DEFAULT_MIN = 1;

/** The configured hold in minutes: ORDER_HOLD_MINUTES, else the default. NaN when the value is not a number —
 *  each reader fails safe on it (holdWindowMs: no hold), and production refuses it at boot. */
export function orderHoldMinutes(env: Record<string, string | undefined> = process.env): number {
  return Number(env['ORDER_HOLD_MINUTES'] ?? ORDER_HOLD_DEFAULT_MIN);
}
