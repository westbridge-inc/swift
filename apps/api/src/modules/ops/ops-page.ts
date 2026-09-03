import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { NotificationService } from '../notification/notification.service';
import { openOpsAlert } from '../safety/ops-alert';
import { opsPageCounter } from '../../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-006] A PLATFORM PAGE IS SUCCESSFUL ONLY WITH DURABLE DELIVERY INTENT
// TO A STAFFED RECIPIENT.
//
// The scheduler-stall page claimed its Redis dedupe key, then looked for
// admins to notify. With no admin to reach the key stayed claimed for thirty
// minutes and nothing was written anywhere: the outage was dark, and the
// process that noticed it believed it had paged someone.
//
// Now a page is an OpsAlert row (the S-19 outbox: recipients, an ACK
// deadline, escalation to on-call SMS) BEFORE it is a notification. The
// dedupe key is claimed only for a page that reached at least one recipient;
// a page with nobody to reach stays PENDING — its row is open, the escalation
// sweep keeps trying (re-resolving recipients each pass), and the key is
// released so the next probe retries rather than trusting a page that never
// happened. One open alert per page title at a time, so a probe every thirty
// seconds cannot storm the outbox.
// ---------------------------------------------------------------------------

export interface PageInput {
  /** The Redis dedupe key for this page (one delivered page per window). */
  key: string;
  /** Window after a DELIVERED page before the same page can go out again. */
  windowSeconds?: number;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export type PageOutcome =
  | { status: 'delivered'; opsAlertId: string; recipients: number }
  | { status: 'pending'; opsAlertId: string }
  | { status: 'deduped' };

export async function pageOps(
  deps: { prisma: PrismaClient; redis: Redis; notifications: NotificationService; resolveRecipients?: () => Promise<string[]> },
  input: PageInput,
): Promise<PageOutcome> {
  // an open page with this title is already the durable intent — do not open another
  const open = await deps.prisma.opsAlert.findFirst({
    where: { kind: 'PLATFORM', title: input.title, acknowledgedAt: null, closedAt: null },
    select: { id: true, recipients: { select: { id: true }, take: 1 } },
  });
  if (open) {
    opsPageCounter.labels('already_open').inc();
    return open.recipients.length > 0 ? { status: 'deduped' } : { status: 'pending', opsAlertId: open.id };
  }
  const claimed = await deps.redis.set(input.key, '1', 'EX', input.windowSeconds ?? 1800, 'NX');
  if (claimed !== 'OK') {
    opsPageCounter.labels('deduped').inc();
    return { status: 'deduped' };
  }
  try {
    const recipientIds = deps.resolveRecipients ? await deps.resolveRecipients() : undefined;
    const res = await openOpsAlert(deps.prisma, deps.notifications, { kind: 'PLATFORM', tenantId: null, title: input.title, body: input.body, data: input.data, recipientIds });
    if (res.recipients === 0) {
      // nobody staffed: the row stays open for escalation and re-resolution; the key is released so the probe retries
      await deps.redis.del(input.key).catch(() => undefined);
      opsPageCounter.labels('zero_recipient_pending').inc();
      return { status: 'pending', opsAlertId: res.opsAlertId };
    }
    opsPageCounter.labels('delivered').inc();
    return { status: 'delivered', opsAlertId: res.opsAlertId, recipients: res.recipients };
  } catch (err) {
    await deps.redis.del(input.key).catch(() => undefined);
    opsPageCounter.labels('failed').inc();
    throw err;
  }
}

/** The paged condition cleared: close its open page(s) so the outbox stays truthful. */
export async function resolveOpsPage(prisma: PrismaClient, title: string, reason = 'condition-cleared'): Promise<number> {
  const r = await prisma.opsAlert.updateMany({ where: { kind: 'PLATFORM', title, closedAt: null }, data: { closedAt: new Date(), closeReason: reason } });
  if (r.count > 0) opsPageCounter.labels('resolved').inc(r.count);
  return r.count;
}
