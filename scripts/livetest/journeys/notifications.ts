// Notification journeys [TASK-057]: NOTIF-01 (device token, event, inbox,
// read, routing data, wrong user) and NOTIF-02 (push, unread re-alert, SMS
// fallback, provider failure). Under the dev providers push and SMS land in
// process memory only, so NOTIF-02 proves what the API exposes and skips the rest.

import type { Journey } from '../journey.js';
import { GET, POST, PUT, req, sleep, brief, waitFor, notificationsOf, customerOrder } from './common.js';
import type { Ctx } from './context.js';
import { placeExpress, storeAccepts } from './dispatch.js';

export const NOTIF_01: Journey<Ctx> = {
  id: 'NOTIF-01',
  estimateSeconds: 60,
  title: 'Push register + inbox',
  cases: 'token registration; event; inbox; mark read; tap routing; wrong-user denial',
  async run(rec, ctx) {
    const C2 = ctx.roster.customers.C2!.session, C3 = ctx.roster.customers.C3!.session;
    const token = `ExponentPushToken[journey-${ctx.runId}]`.slice(0, 200);
    rec.expect('the app registers its push token', await POST('/customer/notifications/devices', { token, platform: 'ios' }, C2.token), [200, 201]);
    rec.deny('a malformed token', await POST('/customer/notifications/devices', { token: 'x', platform: 'ios' }, C2.token), [400], ['VALIDATION_ERROR']);
    rec.deny('an unknown platform', await POST('/customer/notifications/devices', { token, platform: 'blackberry' }, C2.token), [400], ['VALIDATION_ERROR']);
    const unread0 = Number((await GET('/customer/notifications/unread-count', C2.token)).json?.data?.count ?? 0);

    // event: the store accepts an express order → the customer's inbox gets a row
    const placed = await placeExpress(ctx, 'C2', 'R1', 'R1', 'notif01');
    rec.expect('an express order (no hold)', placed.res, [200, 201]);
    const id = placed.id!;
    rec.expect('the store accepts it', await storeAccepts(ctx, 'R1', id), 200);
    const row = await waitFor(async () => (await notificationsOf(C2)).find((n) => n.data?.orderId === id && n.data?.status === 'ACCEPTED'), 20_000);
    rec.check('the acceptance lands in the customer inbox', !!row, row ? `${row.title} — ${row.body}` : 'no row within 20 s');
    const unread1 = Number((await GET('/customer/notifications/unread-count', C2.token)).json?.data?.count ?? 0);
    rec.check('the unread count went up', unread1 > unread0, `${unread0} → ${unread1}`);
    rec.check('the row carries routing data (order id + status) for the tap', !!row?.data?.orderId && !!row?.data?.status, JSON.stringify(row?.data ?? null));

    if (row) {
      const theft = await PUT(`/customer/notifications/${row.id}/read`, {}, C3.token);
      rec.deny('another user marking it read changes nothing', theft, [200, 403, 404], undefined, 'the API answers a silent no-op for a foreign id');
      const still = (await notificationsOf(C2)).find((n) => n.id === row.id);
      rec.check('the owner’s row is still unread after the foreign attempt', still?.isRead === false, `isRead=${still?.isRead}`);
      rec.expect('the owner marks it read', await PUT(`/customer/notifications/${row.id}/read`, {}, C2.token), 200);
      const read = (await notificationsOf(C2)).find((n) => n.id === row.id);
      rec.check('the row reads as read', read?.isRead === true && !!read?.readAt, `isRead=${read?.isRead} readAt=${read?.readAt}`);
      const unread2 = Number((await GET('/customer/notifications/unread-count', C2.token)).json?.data?.count ?? 0);
      rec.check('the unread count went down', unread2 === unread1 - 1, `${unread1} → ${unread2}`);
    }
    rec.expect('the token is unregistered on sign-out', await req('DELETE', '/customer/notifications/devices', { token: C2.token, body: { token } }), 200);
    await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, C2.token);
    rec.deviceCase('push delivery and tap-to-screen', 'the push itself goes to Expo/APNs/FCM and the navigation happens in the app (E28 covers the inbox routing); physical devices are the device gate');
  },
};

export const NOTIF_02: Journey<Ctx> = {
  id: 'NOTIF-02',
  estimateSeconds: 120,
  title: 'SMS fallback + escalation (H-5)',
  cases: 'push; unread realert; SMS fallback; provider failure/retry',
  async run(rec, ctx) {
    const R1 = ctx.roster.vendors.R1!;
    const placed = await placeExpress(ctx, 'C6', 'R1', 'R1', 'notif02');
    rec.expect('an express order raises a new-order alert for the store', placed.res, [200, 201]);
    const id = placed.id!;
    const pending = await waitFor(async () => {
      const a = await GET('/vendor/alerts/pending', R1.session.token);
      return JSON.stringify(a.json?.data ?? []).includes(id) ? a : null;
    }, 20_000);
    rec.check('the store has an unread alert for the order', !!pending, '');
    await sleep(70_000); // past the first re-alert step (60 s)
    const still = await GET('/vendor/alerts/pending', R1.session.token);
    rec.check('unacknowledged, the alert stays pending through the re-alert window', JSON.stringify(still.json?.data ?? []).includes(id), '');
    const health = await GET('/admin/alerts/health?hours=1', ctx.admin.token);
    rec.expect('the operator can read alert delivery health', health, 200, undefined, JSON.stringify(health.json?.data ?? null).slice(0, 200));
    rec.deny('a store cannot read alert health', await GET('/admin/alerts/health', R1.session.token), [403]);
    rec.expect('the store acknowledges by accepting', await storeAccepts(ctx, 'R1', id), 200);
    const cleared = await GET('/vendor/alerts/pending', R1.session.token);
    rec.check('accepting clears the pending alert', !JSON.stringify(cleared.json?.data ?? []).includes(id), '');
    await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, ctx.roster.customers.C6!.session.token);
    void customerOrder; void brief;
    rec.skipAll('the defining cases — push delivery, the SMS fallback and provider failure/retry — are not observable here: NOTIFICATION_PROVIDER=dev and PUSH_PROVIDER dev/expo keep sends in process memory (no delivery log, no DB row), so only the alert’s pending state and the operator health counts can be proven. Phase B (Twilio + push credentials) and physical phones prove the rest');
  },
};

export const NOTIFICATION_JOURNEYS = [NOTIF_01, NOTIF_02];
