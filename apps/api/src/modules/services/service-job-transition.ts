import type {
  NotificationType,
  Prisma,
  ServiceJob,
  ServiceJobStatus,
} from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../utils/errors';

export interface ServiceJobTransitionNotice {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Prisma.InputJsonObject;
}

export interface ServiceJobTransitionInput {
  jobId: string;
  actorUserId: string;
  expectedUpdatedAt: Date;
  from: ServiceJobStatus;
  to: ServiceJobStatus;
  guard?: Prisma.ServiceJobWhereInput;
  data?: Prisma.ServiceJobUpdateManyMutationInput;
  action: string;
  audit?: Prisma.InputJsonObject;
  notices?: ServiceJobTransitionNotice[];
  closeChatRoomId?: string | null;
  now?: Date;
}

export interface ServiceJobTransitionResult {
  job: ServiceJob;
  notificationIds: string[];
}

/**
 * ServiceJob.quoteAmount is Decimal(12,2). Reject values the database would
 * round so the price shown after a quote is exactly the price the provider
 * submitted. String inspection avoids the false negatives produced by
 * `Number.isInteger(amount * 100)` for ordinary values such as 0.29.
 */
export function hasServiceQuotePrecision(amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 100_000_000) return false;
  return /^\d+(?:\.\d{1,2})?$/.test(String(amount));
}

export const serviceQuoteAmountSchema = z.number()
  .min(0.01)
  .max(100_000_000)
  .refine(hasServiceQuotePrecision, 'Quote amount must have no more than two decimal places');

/**
 * `updatedAt` is the existing ServiceJob command generation. Force it to move
 * forward even when two commands arrive in the same millisecond so a command
 * that was built from an older screen can never affect a later lifecycle.
 */
export function nextServiceJobTransitionAt(expectedUpdatedAt: Date, now = new Date()): Date {
  return new Date(Math.max(now.getTime(), expectedUpdatedAt.getTime() + 1));
}

/** A confirmed appointment remains future work until the agreed instant. */
export function assertServiceJobStartDue(expectedScheduledFor: Date, now = new Date()): void {
  if (expectedScheduledFor.getTime() > now.getTime()) {
    throw new AppError(409, 'JOB_NOT_DUE', 'This job cannot start before its agreed time.');
  }
}

/**
 * One transaction owns the state CAS, append-only receipt, durable inbox rows,
 * and terminal chat closure. External socket/push fan-out happens after commit
 * through NotificationService.publishPersisted().
 */
export async function transitionServiceJob(
  tx: Prisma.TransactionClient,
  input: ServiceJobTransitionInput,
): Promise<ServiceJobTransitionResult> {
  const transitionedAt = nextServiceJobTransitionAt(input.expectedUpdatedAt, input.now);
  const changed = await tx.serviceJob.updateMany({
    where: {
      id: input.jobId,
      status: input.from,
      updatedAt: input.expectedUpdatedAt,
      ...(input.guard ? { AND: [input.guard] } : {}),
    },
    data: {
      ...(input.data ?? {}),
      status: input.to,
      updatedAt: transitionedAt,
    },
  });
  if (changed.count !== 1) {
    throw new AppError(409, 'SERVICE_JOB_CHANGED', 'This job changed — refresh it before trying again.');
  }

  const job = await tx.serviceJob.findUniqueOrThrow({ where: { id: input.jobId } });

  await tx.auditLog.create({
    data: {
      userId: input.actorUserId,
      action: input.action,
      entity: 'ServiceJob',
      entityId: input.jobId,
      changes: {
        from: input.from,
        to: input.to,
        expectedUpdatedAt: input.expectedUpdatedAt.toISOString(),
        transitionedAt: transitionedAt.toISOString(),
        ...(input.audit ?? {}),
      } as Prisma.InputJsonValue,
    },
  });

  if (input.closeChatRoomId) {
    await tx.chatRoom.updateMany({
      where: { id: input.closeChatRoomId, isActive: true },
      data: { isActive: false },
    });
  }

  const notificationIds: string[] = [];
  for (const notice of input.notices ?? []) {
    const row = await tx.notification.create({
      data: {
        userId: notice.userId,
        type: notice.type,
        title: notice.title,
        body: notice.body,
        data: notice.data,
        dedupeKey: `service-job:${input.jobId}:${transitionedAt.toISOString()}:${String(notice.data['kind'])}:${notice.userId}`,
      },
      select: { id: true },
    });
    notificationIds.push(row.id);
  }

  return { job, notificationIds };
}
