import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { billingSummary, DAY_LABELS, hoursSummary, orderActions, storeStatusEyebrow, windowTotals } from './vendor-hub';

// Owner ruling (11 Oct 2026): the website's business board copies the phone
// app — same cards, same words, same server data. The app's helpers live in
// files that import React Native, so the web keeps a copy (lib/vendor-hub.ts).
// This census holds every copied function and constant identical to the app.
const MOBILE = join(__dirname, '..', '..', '..', 'mobile', 'src', 'modules', 'vendor');
const SHARED = readFileSync(join(MOBILE, 'shared.tsx'), 'utf8');
const ORDER_STATUS = readFileSync(join(__dirname, '..', '..', '..', 'mobile', 'src', 'lib', 'orderStatus.ts'), 'utf8');
const OPS = readFileSync(join(MOBILE, 'screens', 'VendorOps.tsx'), 'utf8');
const WEB = readFileSync(join(__dirname, 'vendor-hub.ts'), 'utf8');

/** A top-level function's text, from `function NAME(` to its closing brace in column 0. */
function fn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  return src.slice(start, src.indexOf('\n}', start) + 2);
}
const line = (src: string, start: string) => {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`${start} not found`);
  return src.slice(at, src.indexOf('\n', at));
};

const FROM_SHARED = ['safeVendorRole', 'orderActions', 'statusActions', 'timeAgo', 'clock', 'fmtWhen', 'fmtDate', 'numericFact', 'guyanaDate', 'guyanaDayKey', 'hasTrailingGuyanaDays', 'normalizeRevenueDays', 'reconciledRevenueDays', 'windowTotals'];
const FROM_OPS = ['formatBusinessTime', 'normalizeHours', 'hoursSummary', 'storeStatusEyebrow', 'financialDeltaLabel', 'subscriptionTone', 'billingSummary'];

describe('the web board helpers are the app\'s, word for word', () => {
  it.each(FROM_SHARED)('%s matches apps/mobile/src/modules/vendor/shared.tsx', (name) => {
    expect(fn(WEB, name)).toBe(fn(SHARED, name));
  });
  it.each(FROM_OPS)('%s matches apps/mobile/src/modules/vendor/screens/VendorOps.tsx', (name) => {
    expect(fn(WEB, name)).toBe(fn(OPS, name));
  });
  it('canAttestPayment matches apps/mobile/src/lib/orderStatus.ts', () => {
    expect(fn(WEB, 'canAttestPayment')).toBe(fn(ORDER_STATUS, 'canAttestPayment'));
    expect(line(WEB, 'export const ATTESTABLE_PAYMENT_STATUSES')).toBe(line(ORDER_STATUS, 'export const ATTESTABLE_PAYMENT_STATUSES'));
  });
  it('copies the constants and types the functions read', () => {
    for (const start of ["export type VendorMemberRole", "export type VendorOrderActionKind", "const COURIER_ACTIVE = [", "const MONTHS = [", "export const DAY_LABELS = ["]) {
      expect(line(WEB, start)).toBe(line(SHARED, start));
    }
    const type = (src: string, start: string) => src.slice(src.indexOf(start), src.indexOf('};', src.indexOf(start)) + 2);
    expect(type(WEB, 'export type RevenueDay')).toBe(type(SHARED, 'export type RevenueDay'));
    expect(type(WEB, 'type HoursRow = {')).toBe(type(OPS, 'type HoursRow = {'));
  });

  it('behaves like the app on a few known cases', () => {
    expect(orderActions({ status: 'PENDING' }).map((a) => a.label)).toEqual(['Accept', 'Reject']);
    expect(orderActions({ status: 'PREPARING', fulfillment: 'PICKUP' }).map((a) => a.label)).toEqual(['Ready for pickup']);
    expect(orderActions({ status: 'RIDER_ASSIGNED', preparingAt: '2026-10-11T10:00:00Z' }).map((a) => a.label)).toEqual(['Ready for delivery']);
    // [STORE-DASH · REVIEW-F S4-1 on #2024] an unpaid MMG order has no Start preparing (the server refuses it)
    expect(orderActions({ status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })).toEqual([]);
    expect(orderActions({ status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' }).map((a) => a.label)).toEqual(['Start preparing']);
    expect(orderActions({ status: 'ACCEPTED', paymentMethod: 'CASH', paymentStatus: 'PENDING' }).map((a) => a.label)).toEqual(['Start preparing']);
    expect(hoursSummary(DAY_LABELS.map((_, dayOfWeek) => ({ dayOfWeek, openTime: '08:00', closeTime: '22:00', isClosed: false })))).toBe('Daily · 8:00 AM–10:00 PM');
    expect(hoursSummary([])).toBeNull();
    expect(storeStatusEyebrow({ isCurrentlyOpen: false }, false).label).toBe('CLOSED');
    expect(billingSummary(null)).toBe('Subscription not active');
    expect(windowTotals([], 7).prev).toBeNull();
  });
});
