import { createHash } from 'node:crypto';
import type { Notification, Prisma, PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { getChannels, type NotificationChannels, type SubmissionGuard } from '../../providers/notifications/channels';
import { PUSH_DEVICE_SELECT, pushToDevices } from '../../providers/notifications/device-push';
import { log } from '../../utils/logger';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { notificationFailuresCounter } from '../../plugins/observability';
import { storeAlertRecipients } from './store-alert-recipients';
import { storeAlertSubmission, withStoreAlertAuthority } from './store-alert-authority';

/** Per-user channel switches; the vendor order alert ignores these. */
interface NotificationPrefs {
  push: boolean;
  sms: boolean;
  email: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = { push: true, sms: true, email: false };

/** Providers report dead tokens (app uninstalled) — flip them off so future
 *  sends stop paying for ghosts. Best-effort by design. */
export async function deactivateDeadTokens(prisma: PrismaClient, invalidTokens?: string[]): Promise<void> {
  if (!invalidTokens?.length) return;
  await prisma.deviceToken
    .updateMany({ where: { token: { in: invalidTokens } }, data: { isActive: false } })
    .catch(() => {});
}

type NotificationType =
  | 'ORDER_UPDATE'
  | 'PROMOTION'
  | 'SUBSCRIPTION_REMINDER'
  | 'SUBSCRIPTION_EXPIRED'
  | 'PAYMENT_RECEIVED'
  | 'EARNING_AVAILABLE'
  | 'RATING_RECEIVED'
  | 'SYSTEM_ANNOUNCEMENT'
  | 'CHAT_MESSAGE'
  | 'LOW_STOCK'
  | 'SAFETY';

/** Which app-within-the-app a notification belongs to. One ACCOUNT spans
 *  roles, but SURFACES are role-scoped: the shopping app must not feed a
 *  driver's operator alerts. Untagged = legacy rows; clients fall back to a
 *  kind deny-list for those. */
export type NotificationAudience = 'customer' | 'earner' | 'business';

interface NotificationPayload {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Surface this belongs to — merged into data.audience. */
  audience?: NotificationAudience;
  data?: Record<string, unknown>;
  /** [REPORT-034 #30] Deterministic idempotency key, per user. Pass one from
   *  any RETRIED path (every BullMQ job retries with backoff) so a retry that
   *  re-runs `send` collapses into the first delivery instead of duplicating
   *  the inbox row and the push. Omit everywhere else — NULL keys never
   *  collide. Key discipline: derive from the FACT being announced
   *  (`'liveness-prompt:' + deadlineISO`), never from Date.now(). */
  dedupeKey?: string;
}

/** Ops trigger for review queues: PENDING work is invisible until someone is
 *  told it exists — "we review within 24 hours" needs a tap on the shoulder,
 *  not a dashboard someone remembers to open. Fans one notification (row +
 *  live socket) to every active ADMIN/SUPER_ADMIN account. */
/** Stamp acknowledgment on an alert delivery — the recipient ACTED. Idempotent,
 *  fire-and-caught at call sites (tracking never blocks the action).
 *
 *  [AX323 RR2-1] A mover-offer acknowledgment is evidence about ONE offer
 *  attempt, and the offer timeout reads it as proof that the card reached the
 *  mover. Stamped across the whole (order, mover) pair, a delayed decline or
 *  accept of an expired attempt marked an unseen successor as seen, and that
 *  successor's lapse then cost the mover acceptance rate. So a MOVER_OFFER
 *  acknowledgment always names its attempt (the type requires it): `null` is
 *  the legacy pre-attempt row, never "every attempt". */
type AlertAcknowledgment =
  | [kind: 'VENDOR_ORDER', subjectId: string, recipientId?: string]
  | [kind: 'MOVER_OFFER', subjectId: string, recipientId: string, offerAttemptId: string | null];

export async function acknowledgeAlert(prisma: PrismaClient, ...ack: AlertAcknowledgment): Promise<void> {
  const [kind, subjectId, recipientId] = ack;
  await prisma.alertDelivery.updateMany({
    where: {
      kind, subjectId, ...(recipientId ? { recipientId } : {}), acknowledgedAt: null,
      ...(ack[0] === 'MOVER_OFFER' ? { offerAttemptId: ack[3] ?? null } : {}),
    },
    data: { acknowledgedAt: new Date() },
  });
}

/** Resolve the tenant an admin page belongs to from the person it is about.
 *  [NOC-A F45] Most domain events name a user (a ticket opener, a document
 *  submitter, a partner being onboarded) rather than carrying a tenantId of
 *  their own, and the page must follow the SUBJECT's tenant.
 *
 *  [F-027-20] It still returns null when it cannot resolve one, but that null
 *  no longer means "broadcast to every tenant" — since this batch it routes to
 *  platform operators only, so an unresolvable subject fails CLOSED. What it
 *  must not do is fail closed SILENTLY: a lookup that throws is an outage, and
 *  an outage that quietly redirects a tenant's pages away from that tenant's
 *  own responders is exactly the kind of thing nobody notices for months. */
export async function tenantOfUser(prisma: PrismaClient, userId: string | null | undefined, requireResolved = false): Promise<string | null> {
  if (!userId) {
    if (requireResolved) throw new Error('admin page subject unavailable');
    return null;
  }
  const u = await prisma.user
    .findUnique({ where: { id: userId }, select: { tenantId: true } })
    .catch((err) => {
      if (requireResolved) throw err;
      log().error({ err, userId }, '[F-027-20] could not resolve a tenant for an admin page — it will reach PLATFORM OPERATORS ONLY, not this subject’s own admins');
      return null;
    });
  if (!u && requireResolved) throw new Error('admin page subject unavailable');
  return u?.tenantId ?? null;
}

/** Same idea for billing: a Subscription carries no tenantId of its own — it
 *  inherits one from the actor it belongs to (rider, driver, or vendor owner).
 *  [NOC-A F45] */
export async function tenantOfSubscription(prisma: PrismaClient, subscriptionId: string | null | undefined, requireResolved = false): Promise<string | null> {
  if (!subscriptionId) {
    if (requireResolved) throw new Error('admin page subscription unavailable');
    return null;
  }
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: { rider: { select: { userId: true } }, driver: { select: { userId: true } }, vendor: { select: { owner: { select: { userId: true } } } } },
  }).catch(err => {
    if (requireResolved) throw err;
    return null;
  });
  // Durable callers cannot acknowledge a platform-only fallback after a failed
  // lookup. Only a successfully resolved user with tenantId=null is platform scoped.
  return tenantOfUser(prisma, sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId ?? null, requireResolved);
}

/** The tracking row of one deduped ops page to one admin — derived from the
 *  notice and the recipient, so the same page sent again maps onto it.
 *  Exported so a suite can remove exactly the receipts of its own pages. */
export function dedupedOpsAlertId(dedupeKey: string, recipientId: string): string {
  return `ops_alert_${createHash('sha256').update(`${dedupeKey}:${recipientId}`).digest('hex').slice(0, 24)}`;
}

export async function notifyAdmins(
  prisma: PrismaClient,
  notifications: NotificationService,
  /** `tenantId` is REQUIRED — pass the subject's tenant, or an explicit
   *  `null` for a genuinely platform-wide notice. See the note below. */
  input: {
    title: string; body: string; data?: Record<string, unknown>; tenantId: string | null;
    /** [ORDER-SPINE S1-6] Per-recipient idempotency key for a page that a
     *  retried obligation may send again: the retry collapses into the first
     *  delivery, and its tracking row, for every admin who already has it.
     *  Omit it everywhere else. [R13] Durable billing callers pass the
     *  committed event's key; existing callers are unchanged. */
    dedupeKey?: string;
    /** [R13] A durable caller's page must reach every admin; otherwise this
     *  throws so the committed obligation stays retryable. */
    requireAll?: boolean;
    submit?: SubmissionGuard;
  },
): Promise<number> {
  // [REPORT-014 F-014-03] Background workers carry no tenant ALS, so a
  // tenant-A event used to page tenant-B admins with A's order evidence.
  // With a tenantId, ordinary admins are scoped to it; SUPER_ADMIN (the
  // founder god's-eye) is always paged — cross-tenant visibility is that
  // role's sanctioned privilege.
  //
  // [NOC-A F45] That fix existed for months and was passed by FOUR of
  // forty-two callers. Optional meant forgettable, and forgetting was
  // silent: the other thirty-eight paged every ADMIN in every tenant with
  // another tenant's order ids, campaign ids, vendor names and amounts.
  // So the parameter is now REQUIRED and nullable: every caller has to make
  // the tenancy decision, and `null` is a deliberate, greppable statement
  // that a notice really is platform-wide (boot failures, DPA gazette
  // events) rather than an omission the compiler let slide.
  //
  // [F-027-20] ...and then twelve of the fifteen callers that had to choose
  // chose WRONG, because `null` still meant "remove every tenant predicate" —
  // i.e. page every ACTIVE admin in every tenant. Collusion pairs, billing
  // invariant reports with subscription ids and balances, incident patterns
  // with subject ids, ads campaign ids, safety SLA breaches: all of it went
  // to every operator's admins. Requiring a decision does not help if the
  // wrong answer is still catastrophic and the right one is indistinguishable
  // from a resolver that failed.
  //
  // So `null` no longer means EVERYONE. It means PLATFORM OPERATORS —
  // SUPER_ADMIN, the role whose cross-tenant visibility is already
  // sanctioned. That inverts the failure mode: a caller that gets tenancy
  // wrong, or a resolver that could not determine a tenant, now UNDER-notifies
  // (a tenant's own admins miss an event they should have had) instead of
  // disclosing one tenant's data to another. Under-notifying is a bug;
  // disclosing is a breach.
  //
  // Remaining work, registered not hidden: the twelve genuinely per-tenant
  // callers should fan out per tenant so each operator hears about their own
  // rows. Until they do, those events reach platform operators only.
  // [F-028-10] runWithoutTenant is LOAD-BEARING, not belt-and-braces. `User`
  // is an ALS-scoped model, so inside an ordinary authenticated request this
  // lookup was silently intersected with the CALLER's tenant — a
  // notifyAdmins(null) from tenant-A's request found only super-admins who
  // themselves live in tenant A, which in the ordinary deployment shape is
  // ZERO. The 5xx-spike pager then counted that empty page as success and its
  // dedup window kept the outage dark for 15 minutes. Paging operators is a
  // sanctioned cross-tenant read; it must not depend on whose request it
  // happens to run inside.
  const admins = await runWithoutTenant(() => prisma.user.findMany({
    where: input.tenantId
      ? {
        status: 'ACTIVE',
        roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] },
        OR: [{ tenantId: input.tenantId }, { roles: { has: 'SUPER_ADMIN' } }],
      }
      : { status: 'ACTIVE', roles: { has: 'SUPER_ADMIN' } },
    select: { id: true },
  }));
  // [REPORT-035 F-035-06 · S0 evidence] Count DELIVERIES, not candidates.
  // send() deliberately swallows a persist failure and returns '' — so
  // returning admins.length let a page where every insert failed report "N
  // people were paged" into SOS delivery receipts. Only a truthy id is a
  // human with an inbox row (the F-024-04 rule, applied at the source).
  let reached = 0;
  for (const admin of admins) {
    const id = await notifications.send({
      userId: admin.id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: input.title,
      body: input.body,
      data: input.data,
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    }, { submit: input.submit });
    if (id) reached += 1;
  }
  // SWIFT-AUD-D7-03: ops pages get the same ack-tracking as vendor/mover
  // alerts, so /alerts/health can show whether anyone actually SAW them.
  if (admins.length > 0) {
    const subjectId = String((input.data?.['kind'] as string | undefined) ?? 'ops');
    const rows = admins.map((a) => ({ kind: 'ADMIN_OPS', subjectId, recipientId: a.id }));
    // [F-R2-ASTRA-01] A deduped page stays ONE notice per admin however often
    // a retried obligation re-sends it — send() hands back the first delivery
    // and does not fan out again — so it keeps one tracking row per admin
    // too: the row id is derived from (notice, admin) and a retry's insert is
    // skipped. Without a key every call is a new notice, tracked as before.
    const { dedupeKey } = input;
    const tracking: Prisma.AlertDeliveryCreateManyArgs = dedupeKey
      ? { data: rows.map((r) => ({ ...r, id: dedupedOpsAlertId(dedupeKey, r.recipientId) })), skipDuplicates: true }
      : { data: rows };
    await prisma.alertDelivery.createMany(tracking).catch(() => {});
  }
  if (input.requireAll && (admins.length === 0 || reached !== admins.length)) {
    throw new Error('admin notice incomplete');
  }
  return reached;
}

interface DeliveryControl {
  submit?: SubmissionGuard;
  store?: { vendorId: string; userId: string };
}

export class NotificationService {
  constructor(
    private prisma: PrismaClient,
    private io: Server,
    private channels: NotificationChannels = getChannels(),
  ) {}

  async send(payload: NotificationPayload, control: DeliveryControl = {}): Promise<string> {
    const data = payload.audience ? { ...(payload.data ?? {}), audience: payload.audience } : payload.data;

    // A notification is best-effort: a persistence/fan-out hiccup must NEVER
    // throw into the caller's request path. An order that reached DELIVERED must
    // not 500 because its "delivered!" push failed, and a multi-vendor checkout
    // must not strand later vendors because an earlier notify threw
    // [SWIFT-UG-NOTIF-02]. Persist is wrapped (returns '' on failure); fan-out is
    // wrapped separately — every failure is LOGGED, never propagated.
    let notification: { id: string; createdAt: Date };
    try {
      const write = (db: Prisma.TransactionClient | PrismaClient) => db.notification.create({
        data: {
          userId: payload.userId,
          type: payload.type,
          title: payload.title,
          body: payload.body,
          data: (data ?? undefined) as any,
          dedupeKey: payload.dedupeKey ?? null,
        },
      });
      const persisted = control.store
        ? await withStoreAlertAuthority(this.prisma, control.store.vendorId, control.store.userId, (tx) => write(tx))
        : control.submit ? await control.submit(() => write(this.prisma)) : await write(this.prisma);
      if (!persisted) return '';
      notification = persisted;
    } catch (err) {
      // [REPORT-034 #30] A dedupe-key collision is the mechanism WORKING, not
      // a failure: a retried job re-ran a send that already landed. Return the
      // first delivery's id and deliberately do NOT re-fan-out — suppressing
      // the duplicate push is the whole point. (The narrow crash window
      // between persist and fan-out trades a possibly-lost push for never
      // paging a person twice; the inbox row is the durable record either way.)
      if (
        payload.dedupeKey &&
        (err as { code?: string }).code === 'P2002'
      ) {
        try {
          const existing = await this.prisma.notification.findUnique({
            where: { userId_dedupeKey: { userId: payload.userId, dedupeKey: payload.dedupeKey } },
            select: { id: true },
          });
          if (existing) return existing.id;
        } catch { /* fall through to the failure path below */ }
      }
      log().warn({ err, userId: payload.userId, type: payload.type }, 'notification persist failed');
      notificationFailuresCounter.inc({ channel: 'db', stage: 'persist' });
      return '';
    }

    await this.publishPersisted(notification.id, control.submit);
    return notification.id;
  }

  /** Fan out an inbox row that another atomic domain transaction already
   * persisted. This is the post-commit half for liability-sensitive workflows:
   * socket/push failures cannot roll back the domain fact, and retrying this
   * method never inserts a duplicate inbox notification. */
  async publishPersisted(notificationId: string, submit?: SubmissionGuard): Promise<boolean> {
    let notification: Notification | null;
    try {
      notification = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    } catch (err) {
      log().warn({ err, notificationId }, 'persisted notification lookup failed');
      notificationFailuresCounter.inc({ channel: 'db', stage: 'fanout_lookup' });
      return false;
    }
    if (!notification) return false;
    const data = notification.data && typeof notification.data === 'object' && !Array.isArray(notification.data)
      ? notification.data as Record<string, unknown>
      : undefined;

    try {
      // Live socket delivery: a store guard holds recipient authority only until emit.
      const emit = async () => {
        this.io.to(`user:${notification.userId}`).emit('notification', {
          id: notification.id,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          data,
          createdAt: notification.createdAt,
        });
        return true;
      };
      if (submit ? !(await submit(emit)) : !(await emit())) return false;

      // Channel fan-out through the swappable interface, honouring prefs.
      const user = await this.prisma.user.findUnique({
        where: { id: notification.userId },
        select: { notificationPrefs: true },
      });
      const prefs = { ...DEFAULT_PREFS, ...((user?.notificationPrefs as Partial<NotificationPrefs> | null) ?? {}) };

      if (prefs.push) {
        const devices = await this.prisma.deviceToken.findMany({
          where: { userId: notification.userId, isActive: true },
          select: PUSH_DEVICE_SELECT,
        });
        if (devices.length > 0) {
          // Channel failures must never break the request path — but after the
          // provider-level retries (withPushRetry) a final failure is LOGGED,
          // never swallowed silently [SWIFT-UG-NOTIF-01]. [Q10] The payload's
          // kind picks how urgently it travels (alert-class.ts), and each
          // device gets only the channel its installed app has (device-push.ts).
          await pushToDevices(this.channels.push, devices, notification.title, notification.body, data, { submit })
            .then((r) => deactivateDeadTokens(this.prisma, r.invalidTokens))
            .catch((err) => {
              log().warn(
                { err, userId: notification.userId, type: notification.type },
                'push delivery failed after retries',
              );
              notificationFailuresCounter.inc({ channel: 'push', stage: 'send' });
            });
        }
      }
    } catch (err) {
      log().warn(
        { err, userId: notification.userId, type: notification.type },
        'notification fan-out failed',
      );
      notificationFailuresCounter.inc({ channel: 'fanout', stage: 'send' });
    }
    return true;
  }

  /** Direct SMS through the interface (OTPs and other direct texts). The
   *  store ladder's text never comes through here: it is sent only by its
   *  own rung, inside its own budget (store-alert-ladder.ts). */
  async sms(to: string, body: string): Promise<void> {
    // SWIFT-100: fail-soft, but never silent — a dropped OTP/fallback SMS is
    // otherwise invisible. Log the error (never the number or body — rule 4) + count it.
    await this.channels.sms.sendSms(to, body).catch((err) => {
      log().warn({ err }, 'direct SMS delivery failed');
      notificationFailuresCounter.inc({ channel: 'sms', stage: 'direct' });
    });
  }

  async sendToMany(userIds: string[], payload: Omit<NotificationPayload, 'userId'>): Promise<void> {
    await Promise.all(
      userIds.map((userId) => this.send({ ...payload, userId })),
    );
  }

  async markAsRead(userId: string, notificationId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, isRead: false },
    });
  }

  // Order-specific notification helpers
  async orderAccepted(customerId: string, orderNumber: string, vendorName: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Order Accepted!',
      body: `${vendorName} has accepted your order ${orderNumber} and is preparing it.`,
      data: { orderId, orderNumber, status: 'ACCEPTED' },
    });
  }

  /** A SERVICE business confirmed a booking: the customer's slot is reserved.
   *  No kitchen words — a booking is not prepared. Same data shape as
   *  orderAccepted, so the app's notification router lands on the same order
   *  screen it always did. */
  async bookingConfirmed(customerId: string, orderNumber: string, vendorName: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Booking confirmed',
      body: `${vendorName} confirmed your booking ${orderNumber}.`,
      data: { orderId, orderNumber, status: 'ACCEPTED' },
    });
  }

  async orderPreparing(customerId: string, orderNumber: string, vendorName: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Being Prepared',
      body: `${vendorName} is preparing your order ${orderNumber}.`,
      data: { orderId, orderNumber, status: 'PREPARING' },
    });
  }

  async orderReady(customerId: string, orderNumber: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Food Ready!',
      body: `Your order ${orderNumber} is ready and waiting for a rider.`,
      data: { orderId, orderNumber, status: 'READY_FOR_PICKUP' },
    });
  }

  async riderAssigned(customerId: string, orderNumber: string, riderName: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Rider On The Way!',
      body: `${riderName} is heading to pick up your order ${orderNumber}.`,
      data: { orderId, orderNumber, status: 'RIDER_ASSIGNED' },
    });
  }

  async orderPickedUp(customerId: string, orderNumber: string, riderName: string, orderId: string, eta: number): Promise<void> {
    // Template guard [SWIFT-UG-NOTIF-02]: a missing/NaN ETA must never render
    // "Arriving in ~undefined min" to a customer.
    const etaPart = typeof eta === 'number' && Number.isFinite(eta) ? ` Arriving in ~${Math.max(1, Math.round(eta))} min.` : '';
    // [MKT-F057] The delivery PIN belongs in this push: it is the moment of
    // need, and the customer is its holder. Fetched holder-side because the
    // caller's order row is already stripped by HANDOVER_SECRETS_OMIT; a fetch
    // hiccup must never fail the PICKED_UP transition, so it degrades to no PIN.
    const pin = (await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { ridePin: true },
    }).catch(() => null))?.ridePin ?? null;
    const pinPart = pin ? ` Your delivery PIN is ${pin} — give it to your rider at the door.` : '';
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'On Its Way!',
      body: `${riderName} picked up your order ${orderNumber}.${etaPart}${pinPart}`,
      data: { orderId, orderNumber, status: 'PICKED_UP', eta, ...(pin ? { deliveryPin: pin } : {}) },
    });
  }

  /** [ALG-12 / R-12.2.3] Tell the customer BEFORE they check. No `kind`: the
   *  router's orderId default lands on the tracking screen, where the revised
   *  range already shows. */
  async orderRunningLate(customerId: string, orderNumber: string, orderId: string, minutesLate: number, window: { start: Date; end: Date }, status: string): Promise<void> {
    const late = Math.max(1, Math.round(minutesLate));
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guyana', hour: 'numeric', minute: '2-digit', hour12: true });
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: `Running about ${late} min late — sorry`,
      body: `Your order ${orderNumber} now arrives between ${fmt.format(window.start)} and ${fmt.format(window.end)}. We’ll keep you posted.`,
      data: { orderId, orderNumber, status, minutesLate: late, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString() },
      dedupeKey: `promise-revised:${orderId}:${window.end.toISOString()}`,
    });
  }

  async orderDelivered(customerId: string, orderNumber: string, orderId: string): Promise<void> {
    await this.send({
      userId: customerId,
      type: 'ORDER_UPDATE',
      title: 'Delivered!',
      body: `Your order ${orderNumber} has been delivered. Enjoy your meal!`,
      data: { orderId, orderNumber, status: 'DELIVERED' },
    });
  }

  /**
   * THE vendor order alert, to ONE person at the store: a persistent,
   * unmissable event. The unread notification row IS their alert state — the
   * dashboard shows a banner until it is acknowledged (accept/reject/ack) —
   * and while the order waits and nobody on the team has seen it, the ladder
   * (store-alert-ladder.ts) rings again, texts the store, then tells the
   * operators. Its push honours the recipient's push preference, like every
   * send (no client offers that switch yet); the ladder's rungs do not read it.
   *
   * [Q10] `respondBy` is the moment the order auto-cancels (vendorRespondBy):
   * it rides in the payload so the push rings until then and never after,
   * and the store copy is tagged audience business, like the re-alert.
   * [Q10 loud alerts 2/4] newOrderForStore sends this to the whole team.
   */
  async newOrderForVendor(vendorOwnerId: string, orderNumber: string, itemCount: number, total: number, orderId: string, respondBy: Date | null | undefined, vendorId: string): Promise<string> {
    // Alert-delivery tracking (alerts spec §A4) — a row per money-critical
    // alert; the vendor's accept/reject/ack stamps acknowledgedAt. Tracking
    // must never fail the alert itself.
    await this.prisma.alertDelivery
      .create({ data: { kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: vendorOwnerId } })
      .catch(() => {});
    const submit = storeAlertSubmission(this.prisma, vendorId, vendorOwnerId, undefined, () => !respondBy || respondBy.getTime() - Date.now() >= 1_000);
    const notificationId = await this.send({
      userId: vendorOwnerId,
      type: 'ORDER_UPDATE',
      title: 'New Order!',
      body: `Order ${orderNumber} — ${itemCount} item(s), $${total.toLocaleString()} GYD`,
      audience: 'business',
      data: {
        orderId, orderNumber, status: 'PENDING', kind: 'vendor_order_alert',
        ...(respondBy ? { respondBy: respondBy.toISOString() } : {}),
      },
    }, { submit, store: { vendorId, userId: vendorOwnerId } });
    if (!notificationId) return '';

    // Dedicated persistent-alert event for the vendor dashboard banner + ring
    const emit = async () => {
      this.io.to(`user:${vendorOwnerId}`).emit('vendor:order_alert', { notificationId, orderId, orderNumber, total, persistent: true });
      return true;
    };
    await submit(emit);

    return notificationId;
  }

  /**
   * [Q10 loud alerts 2/4] THE new-order alert for a whole store: its owner
   * and every active member of its team (storeAlertRecipients) each get the
   * alert newOrderForVendor sends one person, with their own inbox row and
   * delivery receipt. Until this only the owner was told, so a kitchen run by
   * its staff heard nothing. Sent in parallel: checkout waits for it. Returns
   * each recipient's notification id ('' where a persist failed, as send).
   */
  async newOrderForStore(order: {
    vendorId: string;
    orderId: string;
    orderNumber: string;
    itemCount: number;
    total: number;
    respondBy?: Date | null;
  }): Promise<string[]> {
    const recipients = await storeAlertRecipients(this.prisma, order.vendorId);
    return Promise.all(recipients.map((userId) =>
      this.newOrderForVendor(userId, order.orderNumber, order.itemCount, order.total, order.orderId, order.respondBy, order.vendorId)));
  }

  async newDeliveryForRider(riderId: string, orderNumber: string, vendorName: string, deliveryFee: number, orderId: string): Promise<void> {
    await this.send({
      userId: riderId,
      type: 'ORDER_UPDATE',
      title: 'Delivery Available',
      body: `Pickup from ${vendorName} — $${deliveryFee.toLocaleString()} GYD fee`,
      data: { orderId, orderNumber },
    });
  }

  async earningAvailable(userId: string, amount: number, type: string): Promise<void> {
    await this.send({
      userId,
      type: 'EARNING_AVAILABLE',
      title: 'Earning Available',
      body: `You earned $${amount.toLocaleString()} GYD from ${type.toLowerCase().replace('_', ' ')}.`,
      data: { amount, earningType: type },
    });
  }

  async ratingReceived(userId: string, score: number, from: string): Promise<void> {
    await this.send({
      userId,
      type: 'RATING_RECEIVED',
      title: 'New Rating',
      body: `You received a ${score}-star rating from ${from}.`,
      data: { score },
    });
  }

  async subscriptionReminder(userId: string, dueDate: string, amount: number): Promise<void> {
    await this.send({
      userId,
      type: 'SUBSCRIPTION_REMINDER',
      title: 'Subscription Due Soon',
      body: `Your weekly subscription of $${amount.toLocaleString()} GYD is due on ${dueDate}.`,
      data: { dueDate, amount },
    });
  }

  /** Inventory engine (§4.2): stock crossed the owner's threshold or hit zero. */
  async lowStock(
    userId: string,
    ev: { itemId: string; name: string; remaining: number; kind: 'low' | 'out' },
  ): Promise<void> {
    await this.send({
      userId,
      type: 'LOW_STOCK',
      title: ev.kind === 'out' ? 'Item sold out' : 'Low stock',
      body: ev.kind === 'out'
        ? `${ev.name} sold out and was hidden from your menu. Restock to bring it back.`
        : `${ev.name} is down to ${ev.remaining} in stock.`,
      data: { kind: 'low_stock', itemId: ev.itemId, remaining: ev.remaining },
    });
  }
}
