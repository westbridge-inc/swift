import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// THE SEAMS, READ AS TEXT.
//
// The hosted-handler suite proves the projections behave; this file pins the
// SHAPE that makes them hold, in the repository's own seam-test style, so the
// next edit of a select or a switch cannot quietly reopen the gap:
//
//   - the three customer projections take their vertical from ONE declared
//     discriminator (`orderVertical`), never from the persisted enum;
//   - Home's active-order select asks the database for the fulfillment and
//     the business type — the two facts the discriminator reads;
//   - the ACCEPTED transition tells a booking's customer "confirmed", not
//     "preparing"; the confirmation lives in the notification service;
//   - the provider's decline tells a booking's customer "booking" and
//     "provider", never "order" and "store";
//   - the cancellation predicate reads the booked slot.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(resolve(__dirname, rel), 'utf8'));

const CUSTOMER = read('../modules/user/customer.routes.ts');
const ORDER_SERVICE = read('../modules/order/order.service.ts');
const NOTIFICATIONS = read('../modules/notification/notification.service.ts');
const CANCEL_POLICY = read('../modules/order/cancel-policy.ts');
const VENDOR = read('../modules/vendor/vendor.routes.ts');

describe('customer projections declare the vertical from one discriminator', () => {
  it('imports orderVertical from the order module and uses it on Home, the list and the detail', () => {
    expect(CUSTOMER).toMatch(/import \{[^}]*\borderVertical\b[^}]*\} from '\.\.\/order\/order-vertical'/);
    const uses = CUSTOMER.match(/vertical: orderVertical\(/g) ?? [];
    expect(uses.length, 'Home activeOrder, GET /orders rows and GET /orders/:id must each project `vertical`').toBeGreaterThanOrEqual(3);
  });

  it('Home’s active-order select sends the fulfillment and the business type the discriminator reads', () => {
    const start = CUSTOMER.indexOf("app.get('/home'");
    const end = CUSTOMER.indexOf("app.get('/vendors'", start);
    expect(start).toBeGreaterThan(-1);
    const home = CUSTOMER.slice(start, end > start ? end : undefined);
    const active = home.slice(home.indexOf('app.prisma.order.findFirst('), home.indexOf("orderBy: { placedAt: 'desc' }"));
    expect(active.length).toBeGreaterThan(100);
    expect(active).toMatch(/\bfulfillment: true\b/);
    expect(active).toMatch(/vendor: \{ select: \{[^}]*\bvendorType: true\b[^}]*\} \}/);
  });
});

describe('the acceptance push distinguishes a booking from a kitchen order', () => {
  it('order.service.ts routes an APPOINTMENT acceptance to bookingConfirmed', () => {
    const accepted = ORDER_SERVICE.slice(ORDER_SERVICE.indexOf("case 'ACCEPTED':"), ORDER_SERVICE.indexOf("case 'PREPARING':"));
    expect(accepted.length).toBeGreaterThan(50);
    expect(accepted).toMatch(/fulfillment === 'APPOINTMENT'/);
    expect(accepted).toMatch(/notifications\.bookingConfirmed\(/);
    expect(accepted).toMatch(/notifications\.orderAccepted\(/);
  });

  it('notification.service.ts owns the confirmation and it says nothing about preparing food', () => {
    const start = NOTIFICATIONS.indexOf('async bookingConfirmed(');
    expect(start, 'NotificationService.bookingConfirmed must exist').toBeGreaterThan(-1);
    const body = NOTIFICATIONS.slice(start, NOTIFICATIONS.indexOf('\n  }\n', start));
    expect(body).not.toMatch(/prepar/i);
    expect(body).toMatch(/status: 'ACCEPTED'/);
  });
});

describe('the decline push distinguishes a booking from a kitchen order', () => {
  it('vendor.routes.ts’s reject handler words its customer push from the appointment fulfillment', () => {
    const start = VENDOR.indexOf("'/orders/:id/reject'");
    const end = VENDOR.indexOf("app.get('/categories'", start);
    expect(start).toBeGreaterThan(-1);
    const reject = VENDOR.slice(start, end > start ? end : undefined);
    expect(reject.length).toBeGreaterThan(200);
    expect(reject).toMatch(/fulfillment === 'APPOINTMENT'/);
    expect(reject).toMatch(/Booking declined/);
    expect(reject).toMatch(/Order declined/);
    expect(reject).not.toMatch(/was declined by the store\./);
    expect(reject).not.toMatch(/the store refunds you directly/);
  });
});

describe('the cancellation predicate reads the booked slot', () => {
  it('CancellationSnapshot declares appointmentSlot and both policy functions read it', () => {
    expect(CANCEL_POLICY).toMatch(/appointmentSlot\?: Date \| null/);
    const predicate = CANCEL_POLICY.slice(CANCEL_POLICY.indexOf('export function isFreeCancellation'), CANCEL_POLICY.indexOf('export function freeCancellationExpiresAt'));
    const window = CANCEL_POLICY.slice(CANCEL_POLICY.indexOf('export function freeCancellationExpiresAt'));
    expect(predicate).toMatch(/appointmentSlot/);
    expect(window).toMatch(/appointmentSlot/);
  });
});
