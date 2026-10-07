/**
 * [REVIEW-PARTNER · STA-1 DL-5/DL-6] The outbound seal of the store-review fiction.
 *
 * The fiction (a REVIEW tenant) must never cause a real text, push or email —
 * not to its own fictional identifiers, not to an emergency contact a reviewer
 * typed, not to a real operator. Refusing route by route keeps missing paths,
 * so the seal sits at the ONE layer every sender passes: the channels
 * `getChannels()` hands out (channels.ts). Every caller — safety contacts and
 * their resends, SOS, money-command notices and their retry sweeps, billing
 * notices, step-up, the vendor alert ladder — inherits it.
 *
 * A send is the fiction's, and is SUPPRESSED (counted, logged as
 * "review-tenant send suppressed", never the destination or the body), when:
 *   1. it runs on behalf of a REVIEW tenant declared with `sendOnBehalfOf`
 *      (background work about a subject: an SOS escalation, an all-clear), or
 *   2. it runs inside a request bound to a REVIEW tenant (the caller is a
 *      reviewer), or
 *   3. its destination is an account of a REVIEW tenant (an SMS to a demo
 *      identifier, a push to a demo device, an email to a demo address).
 * Everything else is delivered exactly as before.
 *
 * A lookup that fails does not block delivery: a real person's safety text is
 * never lost to a database hiccup; the failure is logged loudly instead.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NotificationChannels, PushOptions, SmsProvider, PushProvider, EmailProvider } from './channels';
import { getTenantContext, runAsSystem } from '../../plugins/tenant-context';
import { reviewSendSuppressedCounter } from '../../plugins/observability';
import { log } from '../../utils/logger';

const KEY = Symbol.for('swift.reviewSendSubject');
const globalRef = globalThis as unknown as { [KEY]?: AsyncLocalStorage<{ tenantId: string | null }> };
const subjectContext: AsyncLocalStorage<{ tenantId: string | null }> =
  globalRef[KEY] ?? (globalRef[KEY] = new AsyncLocalStorage<{ tenantId: string | null }>());

/** Declare whose send this is, for background work that runs without a request (e.g. an SOS escalation). */
export async function sendOnBehalfOf<T>(tenantId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return subjectContext.run({ tenantId: tenantId ?? null }, async () => await fn());
}

type Channel = 'sms' | 'push' | 'email';
export type SuppressReason = 'subject' | 'request' | 'destination';

const KIND_TTL_MS = 60_000;
const kindCache = new Map<string, { kind: string | null; at: number }>();

async function db() {
  return (await import('../../plugins/prisma')).scopedPrisma;
}

async function tenantKind(tenantId: string): Promise<string | null> {
  const hit = kindCache.get(tenantId);
  if (hit && Date.now() - hit.at < KIND_TTL_MS) return hit.kind;
  const prisma = await db();
  const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { kind: true } });
  kindCache.set(tenantId, { kind: row?.kind ?? null, at: Date.now() });
  return row?.kind ?? null;
}

async function destinationIsReview(channel: Channel, to: string[]): Promise<boolean> {
  const prisma = await db();
  return runAsSystem('review-send-seal', async () => {
    if (channel === 'sms') {
      const u = await prisma.user.findUnique({ where: { phone: to[0]! }, select: { tenant: { select: { kind: true } } } });
      return u?.tenant.kind === 'REVIEW';
    }
    if (channel === 'email') {
      const u = await prisma.user.findFirst({ where: { email: to[0]! }, select: { tenant: { select: { kind: true } } } });
      return u?.tenant.kind === 'REVIEW';
    }
    const owners = await prisma.deviceToken.findMany({ where: { token: { in: to } }, select: { user: { select: { tenant: { select: { kind: true } } } } } });
    return owners.some((o) => o.user.tenant.kind === 'REVIEW');
  });
}

/** Why this send must not leave, or null when it may. */
export async function reviewSendSuppression(channel: Channel, to: string[]): Promise<SuppressReason | null> {
  try {
    const declared = subjectContext.getStore();
    if (declared?.tenantId && (await tenantKind(declared.tenantId)) === 'REVIEW') return 'subject';
    const bound = getTenantContext().tenantId;
    if (bound && (await tenantKind(bound)) === 'REVIEW') return 'request';
    if (to.length > 0 && (await destinationIsReview(channel, to))) return 'destination';
    return null;
  } catch (err) {
    log().error({ err, channel }, '[REVIEW-PARTNER] review send seal could not decide — delivering (a real person must never lose a message to a lookup failure)');
    return null;
  }
}

function suppressed(channel: Channel, reason: SuppressReason): void {
  reviewSendSuppressedCounter.labels(channel, reason).inc();
  log().info({ channel, reason }, 'review-tenant send suppressed');
}

/** One SMS provider, sealed. */
export function sealSms(inner: SmsProvider): SmsProvider {
  return {
    sendSms: async (to: string, body: string) => {
      const why = await reviewSendSuppression('sms', [to]);
      if (why) { suppressed('sms', why); return { ref: 'review-suppressed' }; }
      return inner.sendSms(to, body);
    },
  };
}

/** One push provider, sealed. A wrapper's `inner` (the selected provider) stays visible. */
export function sealPush<P extends PushProvider>(inner: P): PushProvider & Pick<P & { inner?: PushProvider }, 'inner'> {
  return {
    ...('inner' in inner ? { inner: (inner as { inner?: PushProvider }).inner } : {}),
    sendPush: async (deviceTokens: string[], title: string, body: string, data?: Record<string, unknown>, options?: PushOptions) => {
      const why = await reviewSendSuppression('push', deviceTokens);
      if (why) { suppressed('push', why); return { sent: 0, invalidTokens: [] }; }
      return inner.sendPush(deviceTokens, title, body, data, options);
    },
  } as PushProvider & Pick<P & { inner?: PushProvider }, 'inner'>;
}

/** One email provider, sealed. */
export function sealEmail(inner: EmailProvider): EmailProvider {
  return {
    sendEmail: async (to: string, subject: string, body: string) => {
      const why = await reviewSendSuppression('email', [to]);
      if (why) { suppressed('email', why); return { ref: 'review-suppressed' }; }
      return inner.sendEmail(to, subject, body);
    },
  };
}

/** A provider object is sealed once: a long-lived one (the dev SMS) stays one shared object. */
const sealedSms = new WeakMap<SmsProvider, SmsProvider>();

/** The channels, sealed: a send of the fiction is suppressed before the provider is called. */
export function sealReviewChannels(channels: NotificationChannels): NotificationChannels {
  let sms = sealedSms.get(channels.sms);
  if (!sms) { sms = sealSms(channels.sms); sealedSms.set(channels.sms, sms); }
  return { sms, push: sealPush(channels.push), email: sealEmail(channels.email) };
}

/** Test seam: forget cached tenant kinds. */
export function resetReviewSealCache(): void {
  kindCache.clear();
}
