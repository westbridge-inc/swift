import type { PrismaClient } from '@prisma/client';
import { toGsm7 } from '../../utils/sms-text';

// ---------------------------------------------------------------------------
// [STORE-ALERT · owner ruling 18 Oct 2026] The store's backup SMS names the
// store and the minutes until the order cancels by itself:
//
//   Swift: new order <orderNumber> at <store name> is waiting. Open the Swift
//   app to accept or decline. It cancels by itself in <N> min.
//
// Plain GSM-7 and ONE message: a single character outside the GSM 03.38 basic
// set (a curly apostrophe in a store name, an emoji) switches the whole SMS to
// UCS-2, where one segment holds 70 characters instead of 160, so the text
// would be split or cut. The store name is therefore normalised to the basic
// set (look-alikes mapped, accents dropped, anything else removed) and trimmed
// so the whole message fits 160 characters.
//
// <N> is counted from the moment the auto-cancel job really fires (its outbox
// row: created + delay, the anchor the drainer schedules from), at send time,
// rounded DOWN: telling a store it has more time than it has is the harmful
// direction.
// ---------------------------------------------------------------------------

export const SMS_SINGLE_SEGMENT = 160;

/** [SMS-COST] The GSM-7 reduction is shared by every SMS sender now (utils/sms-text.ts):
 *  the same basic set, the same look-alikes, the same accent folding. */
export { toGsm7, isGsm7Basic } from '../../utils/sms-text';

/** "It cancels by itself in <N> min." — N rounded down, never inflated. */
function cancelsIn(cancelAt: Date, now: Date): string {
  const minutes = Math.floor((cancelAt.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return 'under 1 min';
  // A booking's clock can run for hours; 600 min would read like a typo.
  if (minutes >= 120) return `${Math.floor(minutes / 60)} h`;
  return `${minutes} min`;
}

export function vendorAlertSmsText(input: {
  orderNumber: string;
  storeName: string | null | undefined;
  cancelAt: Date | null;
  now: Date;
}): string {
  const orderNumber = toGsm7(input.orderNumber);
  const head = `Swift: new order ${orderNumber}`;
  const mid = ' is waiting. Open the Swift app to accept or decline.';
  const tail = input.cancelAt ? ` It cancels by itself in ${cancelsIn(input.cancelAt, input.now)}.` : '';
  const room = SMS_SINGLE_SEGMENT - head.length - ' at '.length - mid.length - tail.length;
  let store = toGsm7(input.storeName ?? '') || 'your store';
  if (store.length > room) store = store.slice(0, Math.max(0, room)).replace(/[\s,.;:'"(/-]+$/u, '');
  const text = store ? `${head} at ${store}${mid}${tail}` : `${head}${mid}${tail}`;
  return text.slice(0, SMS_SINGLE_SEGMENT);
}

/** The moment the order's auto-cancel job fires: its newest outbox row's
 *  creation + delay (checkout-outbox.ts schedules the job from exactly that
 *  anchor). Falls back to the alert's respondBy, then to nothing. */
export async function autoCancelMoment(
  prisma: Pick<PrismaClient, 'orderOutbox'>,
  orderId: string,
  fallback?: Date | string | null,
): Promise<Date | null> {
  const row = await prisma.orderOutbox.findFirst({
    where: { orderId, kind: 'auto-cancel' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, delayMs: true },
  });
  if (row) return new Date(row.createdAt.getTime() + row.delayMs);
  if (fallback == null) return null;
  const parsed = fallback instanceof Date ? fallback : new Date(fallback);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The full backup SMS for one order, read at send time. */
export async function vendorAlertSms(
  prisma: Pick<PrismaClient, 'orderOutbox' | 'vendor'>,
  input: { orderId: string; orderNumber: string; vendorId: string | null; respondBy?: Date | string | null; now?: Date },
): Promise<string> {
  const [store, cancelAt] = await Promise.all([
    input.vendorId ? prisma.vendor.findUnique({ where: { id: input.vendorId }, select: { name: true } }) : null,
    autoCancelMoment(prisma, input.orderId, input.respondBy),
  ]);
  return vendorAlertSmsText({ orderNumber: input.orderNumber, storeName: store?.name, cancelAt, now: input.now ?? new Date() });
}
