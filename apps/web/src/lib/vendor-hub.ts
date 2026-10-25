// ---------------------------------------------------------------------------
// The business board's helpers, copied WORD FOR WORD from the phone app
// (owner ruling, 11 Oct 2026: the website copies the app). The app keeps them
// in apps/mobile/src/modules/vendor/shared.tsx and screens/VendorOps.tsx,
// which import React Native, so the web cannot import those files. The census
// test (vendor-hub.test.ts) compares every function and constant below with
// the app's text, so the two can never drift. Plain app files are imported
// directly instead (order-dispute, delivery-owner, appointmentTime).
// ---------------------------------------------------------------------------
import { withoutForwardWorkWhilePaused } from '../../../mobile/src/modules/vendor/order-dispute';
import { customerDeciding, mmgAwaitingPayment, nothingToAccept } from '../../../mobile/src/modules/vendor/storeOrderRules';
import { canVendorConfirmDelivered } from '../../../mobile/src/modules/vendor/screens/delivery-owner';
import { addAppointmentDays, appointmentDayKey } from '../../../mobile/src/lib/appointmentTime';
import { billingHeadline } from './subscription-words';

export type VendorOrderActionKind = 'accept' | 'preparing' | 'ready' | 'delivered' | 'reject' | 'complete-pickup' | 'complete-appointment' | 'confirm-payment' | 'handed-to-rider' | 'handed-to-customer';

const COURIER_ACTIVE = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];

export function orderActions(order: any): { label: string; action: VendorOrderActionKind }[] {
  // [NO-DEAD-ENDS · S1-6] A disputed MMG order is paused: no forward button
  // that the server refuses on every tap (order-dispute.ts).
  return withoutForwardWorkWhilePaused(order, statusActions(order));
}

export function statusActions(order: any): { label: string; action: VendorOrderActionKind }[] {
  const s = (order?.status || '').toUpperCase();
  const isPickup = order?.fulfillment === 'PICKUP';
  const isAppt = order?.fulfillment === 'APPOINTMENT';
  if (s === 'PENDING' || s === 'PLACED') {
    // [STORE-DASH · O-4] While the customer answers an "Out of stock" question, or once every item
    // came off, the store cannot accept (the server refuses: CUSTOMER_DECIDING / NOTHING_TO_ACCEPT).
    if (customerDeciding(order) || nothingToAccept(order)) return [{ label: isAppt ? 'Decline' : 'Reject', action: 'reject' }];
    return [{ label: 'Accept', action: 'accept' }, { label: isAppt ? 'Decline' : 'Reject', action: 'reject' }];
  }
  // Appointments skip prepare/ready — accepting books the slot, then the vendor marks it done.
  if (isAppt && (s === 'ACCEPTED' || s === 'CONFIRMED')) return [{ label: 'Mark complete', action: 'complete-appointment' }];
  // [STORE-DASH · REVIEW-F S4-1 on #2024] An unpaid MMG order moves only after "Paid by MMG" (the server
  // refuses Start preparing with MMG_PAYMENT_PENDING), so that is its one step, on the card's MMG block.
  if ((s === 'ACCEPTED' || s === 'CONFIRMED') && mmgAwaitingPayment(order)) return [];
  if (s === 'ACCEPTED' || s === 'CONFIRMED') return [{ label: 'Start preparing', action: 'preparing' }];
  // [STORE-DASH · owner 22 Oct 2026] The button names the next step in the owner's words: ready for pickup or for delivery.
  if (s === 'PREPARING') return [{ label: isPickup ? 'Ready for pickup' : 'Ready for delivery', action: 'ready' }];
  // A rider claimed the order before the kitchen tapped anything (the normal
  // case when movers are close) — the buttons keep working via timestamps.
  if (COURIER_ACTIVE.includes(s)) {
    if (!order?.preparingAt) return [{ label: 'Start preparing', action: 'preparing' }];
    if (!order?.readyAt) return [{ label: 'Ready for delivery', action: 'ready' }];
    return [];
  }
  // Takeaway: the vendor closes the order when the customer collects it (no rider).
  if ((s === 'READY' || s === 'READY_FOR_PICKUP') && isPickup) return [{ label: 'Mark picked up', action: 'complete-pickup' }];
  // Store-owned delivery has its own terminal ceremony. Platform-rider orders
  // remain exclusively completable from the assigned rider's app.
  if (canVendorConfirmDelivered({
    fulfillment: order?.fulfillment,
    fulfillmentMode: order?.fulfillmentMode,
    status: order?.status,
    riderId: order?.riderId,
    riderPresent: Boolean(order?.rider),
  })) return [{ label: 'Confirm delivered', action: 'delivered' }];
  return [];
}

export function timeAgo(iso?: string) {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function clock(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function fmtWhen(iso?: string) {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 48 * 60) return timeAgo(iso);
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(d)}`;
}

export function fmtDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export type RevenueDay = {
  date: string;
  revenue: number;
  orders?: number;
  isToday?: boolean;
};

export function numericFact(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n : null;
}

export function guyanaDate(offsetDays = 0) {
  return new Date(`${guyanaDayKey(offsetDays)}T00:00:00.000Z`);
}

export function guyanaDayKey(offsetDays = 0) {
  return addAppointmentDays(appointmentDayKey(new Date()), offsetDays);
}

export function hasTrailingGuyanaDays(daily: RevenueDay[], take: number) {
  if (take <= 0) return false;
  const keys = new Set(daily.map((day) => day.date));
  return Array.from({ length: take }, (_, index) => guyanaDayKey(index - take + 1)).every((key) => keys.has(key));
}

export function normalizeRevenueDays(payload: any): RevenueDay[] {
  const rows: any[] = Array.isArray(payload) ? payload : Array.isArray(payload?.daily) ? payload.daily : [];
  return rows
    .map((row) => {
      const revenue = numericFact(row?.revenue ?? row?.total);
      if (!row?.date || revenue == null) return null;
      const orders = numericFact(row?.orders);
      return {
        date: String(row.date),
        revenue,
        ...(orders == null ? {} : { orders }),
        ...(row.isToday === undefined ? {} : { isToday: !!row.isToday }),
      };
    })
    .filter((row): row is RevenueDay => row !== null);
}

export function reconciledRevenueDays(payload: any, overview: any, requestedDays: number): RevenueDay[] {
  const rows = normalizeRevenueDays(payload);
  if (rows.length === 0 || rows.some((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date))) return rows;
  const todayRevenue = numericFact(overview?.today?.revenue ?? overview?.today?.total);
  const key = guyanaDayKey();
  const existingToday = rows.find((row) => row.date === key);
  const endpointOrders = numericFact(payload?.totals?.orders);
  const allBucketsKnown = rows.every((row) => numericFact(row.orders) != null);
  const bucketedOrders = allBucketsKnown
    ? rows.reduce((sum, row) => sum + Number(row.orders), 0)
    : null;
  // Overview.today.orders is every still-live order placed today, while this
  // series is completed orders only. Recover the missing completed-today bucket
  // from the revenue endpoint's own total instead of corrupting AOV with the
  // broader overview count.
  const inferredTodayOrders = endpointOrders != null && bucketedOrders != null
    ? endpointOrders - bucketedOrders
    : null;
  const todayOrders = numericFact(existingToday?.orders) ?? (inferredTodayOrders != null && inferredTodayOrders >= 0 ? inferredTodayOrders : null);
  if (todayRevenue == null) return rows;
  return [
    ...rows.filter((row) => row.date !== key),
    { date: key, revenue: todayRevenue, ...(todayOrders == null ? {} : { orders: todayOrders }), isToday: true },
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-requestedDays);
}

export function windowTotals(daily: RevenueDay[], take: number) {
  const safeTake = Math.max(0, Math.min(take, daily.length));
  const sumRevenue = (rows: RevenueDay[]) => rows.reduce((sum, day) => sum + day.revenue, 0);
  const sumOrders = (rows: RevenueDay[]) =>
    rows.every((day) => numericFact(day.orders) != null)
      ? rows.reduce((sum, day) => sum + Number(day.orders), 0)
      : null;
  const cur = safeTake > 0 ? daily.slice(-safeTake) : [];
  const prevRows = daily.slice(-take * 2, -take);
  const datedSeries = daily.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
  const previousComplete = !datedSeries || hasTrailingGuyanaDays(daily, take * 2);
  const prev = take > 0 && prevRows.length === take && previousComplete
    ? { revenue: sumRevenue(prevRows), orders: sumOrders(prevRows) }
    : null;
  return { curDaily: cur, cur: { revenue: sumRevenue(cur), orders: sumOrders(cur) }, prev };
}

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type HoursRow = {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
};

export function formatBusinessTime(value?: string | null) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [rawHour, minute] = value.split(':').map(Number);
  const suffix = rawHour! >= 12 ? 'PM' : 'AM';
  const hour = rawHour! % 12 || 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function normalizeHours(rows: any): HoursRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: any) => {
      const namedDay = typeof row?.day === 'string' ? DAY_LABELS.findIndex((d) => d.toLowerCase() === row.day.toLowerCase().slice(0, 3)) : -1;
      const dayOfWeek = Number.isInteger(row?.dayOfWeek) ? row.dayOfWeek : namedDay;
      if (dayOfWeek < 0 || dayOfWeek > 6) return null;
      return {
        dayOfWeek,
        openTime: String(row.openTime ?? row.open ?? ''),
        closeTime: String(row.closeTime ?? row.close ?? ''),
        isClosed: Boolean(row.isClosed ?? row.closed),
      };
    })
    .filter((row): row is HoursRow => row !== null)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

export function hoursSummary(rows: any): string | null {
  const hours = normalizeHours(rows);
  if (hours.length === 0) return null;
  const open = hours.filter((row) => !row.isClosed);
  if (open.length === 0) return 'Closed all week';
  const first = open[0]!;
  const sameWindow = open.every((row) => row.openTime === first.openTime && row.closeTime === first.closeTime);
  const from = formatBusinessTime(first.openTime);
  const to = formatBusinessTime(first.closeTime);
  const window = from && to ? `${from}–${to}` : null;
  if (open.length === 7 && sameWindow && window) return `Daily · ${window}`;
  if (open.length === 1 && window) return `${DAY_LABELS[first.dayOfWeek]} · ${window}`;
  if (sameWindow && window) return `${open.length} open days · ${window}`;
  return `${open.length} open days · hours vary`;
}

export function storeStatusEyebrow(store: any, inPreview: boolean) {
  if (inPreview) return { label: 'PREVIEW · READ ONLY', tone: 'brand' as const };
  const open = !!store?.isCurrentlyOpen;
  const accepting = !!store?.acceptingOrders;
  const today = normalizeHours(store?.operatingHours).find((row) => row.dayOfWeek === guyanaDate().getUTCDay());
  const schedule = today && !today.isClosed
    ? [formatBusinessTime(today.openTime), formatBusinessTime(today.closeTime)].filter(Boolean).join('–')
    : null;
  const status = !open ? 'CLOSED' : accepting ? 'OPEN' : 'OPEN · ORDERS PAUSED';
  return {
    label: schedule ? `${status} · TODAY ${schedule}` : status,
    tone: !open ? ('muted' as const) : accepting ? ('success' as const) : ('warning' as const),
  };
}

export function financialDeltaLabel(cur: number, prev: number | null) {
  if (prev == null) return undefined;
  if (prev <= 0) return cur > 0 ? 'New revenue in this period' : undefined;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (Math.abs(pct) < 1) return 'Revenue level with previous period';
  return `Revenue ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)} percent`;
}

// [FEE-STATUS · owner 25 Oct 2026] The Billing tile says where the fee stands, in the API's words
// (lib/subscription-words billingHeadline): it read "Next bill 13 Oct" on 25 October. The phone's tile
// (VendorOps billingSummary) works the same words out for an older API; the web ships with its API.
export function billingSummary(sub: any) {
  if (!sub) return 'Subscription not active';
  return billingHeadline(sub);
}

export type VendorMemberRole = 'OWNER' | 'MANAGER' | 'STAFF';

export function safeVendorRole(value: unknown): VendorMemberRole | undefined {
  return value === 'OWNER' || value === 'MANAGER' || value === 'STAFF' ? value : undefined;
}

// From apps/mobile/src/lib/orderStatus.ts (copied: that file's word tables are not needed here).
export const ATTESTABLE_PAYMENT_STATUSES = ['PENDING', 'AUTHORIZED'] as const;

export function canAttestPayment(paymentStatus: string | null | undefined): boolean {
  return (ATTESTABLE_PAYMENT_STATUSES as readonly string[]).includes(String(paymentStatus ?? ''));
}
