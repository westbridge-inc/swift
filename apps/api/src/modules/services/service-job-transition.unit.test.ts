import { describe, expect, it, vi } from 'vitest';
import type { Prisma, ServiceJob } from '@prisma/client';
import {
  assertServiceJobStartDue,
  hasServiceQuotePrecision,
  nextServiceJobTransitionAt,
  serviceQuoteAmountSchema,
  transitionServiceJob,
} from './service-job-transition';

const baseJob = (updatedAt: Date): ServiceJob => ({
  id: 'job-1',
  tenantId: 'tenant-a',
  customerId: 'customer-1',
  providerId: 'provider-1',
  description: 'Repair the kitchen tap',
  photos: [],
  status: 'IN_PROGRESS',
  quoteAmount: null,
  scheduledFor: new Date('2026-09-20T13:00:00.000Z'),
  providerConfirmedAt: new Date('2026-09-19T13:00:00.000Z'),
  chatRoomId: 'room-1',
  completedAt: null,
  cancelledAt: null,
  createdAt: new Date('2026-09-19T12:00:00.000Z'),
  updatedAt,
});

function fakeTx(count = 1) {
  const expected = new Date('2026-09-20T13:00:00.000Z');
  const job = baseJob(new Date('2026-09-20T13:00:00.001Z'));
  const tx = {
    serviceJob: {
      updateMany: vi.fn().mockResolvedValue({ count }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(job),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    chatRoom: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    notification: { create: vi.fn().mockResolvedValue({ id: 'notice-1' }) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, expected, job };
}

describe('service-job transition command', () => {
  it('accepts only amounts Decimal(12,2) can preserve exactly', () => {
    expect(hasServiceQuotePrecision(0.01)).toBe(true);
    expect(hasServiceQuotePrecision(0.29)).toBe(true);
    expect(hasServiceQuotePrecision(15000)).toBe(true);
    expect(hasServiceQuotePrecision(15000.25)).toBe(true);
    expect(hasServiceQuotePrecision(0)).toBe(false);
    expect(hasServiceQuotePrecision(0.001)).toBe(false);
    expect(hasServiceQuotePrecision(15000.009)).toBe(false);
    expect(hasServiceQuotePrecision(Number.NaN)).toBe(false);
    expect(serviceQuoteAmountSchema.parse(15000.25)).toBe(15000.25);
    expect(serviceQuoteAmountSchema.safeParse(0).success).toBe(false);
    expect(serviceQuoteAmountSchema.safeParse(0.001).success).toBe(false);
    expect(serviceQuoteAmountSchema.safeParse(15000.009).success).toBe(false);
  });

  it('always advances the existing updatedAt generation', () => {
    const expected = new Date('2026-09-20T13:00:00.000Z');
    expect(nextServiceJobTransitionAt(expected, expected).toISOString()).toBe('2026-09-20T13:00:00.001Z');
    expect(nextServiceJobTransitionAt(expected, new Date('2026-09-20T13:00:01.000Z')).toISOString())
      .toBe('2026-09-20T13:00:01.000Z');
  });

  it('does not let a confirmed appointment start before its agreed time', () => {
    const scheduledFor = new Date('2026-09-20T13:00:00.000Z');
    expect(() => assertServiceJobStartDue(
      scheduledFor,
      new Date('2026-09-20T12:59:59.999Z'),
    )).toThrow(expect.objectContaining({ statusCode: 409, code: 'JOB_NOT_DUE' }));
    expect(() => assertServiceJobStartDue(scheduledFor, scheduledFor)).not.toThrow();
  });

  it('commits one CAS winner with its receipt, chat closure, and durable notice', async () => {
    const { tx, raw, expected, job } = fakeTx();
    const result = await transitionServiceJob(tx, {
      jobId: job.id,
      actorUserId: 'provider-user',
      expectedUpdatedAt: expected,
      from: 'IN_PROGRESS',
      to: 'COMPLETED',
      data: { completedAt: new Date('2026-09-20T13:00:00.001Z') },
      action: 'SERVICE_JOB_COMPLETED',
      audit: { providerId: job.providerId },
      closeChatRoomId: job.chatRoomId,
      notices: [{
        userId: job.customerId,
        type: 'ORDER_UPDATE',
        title: 'Complete',
        body: 'Done',
        data: { kind: 'booking_completed', jobId: job.id },
      }],
      now: expected,
    });

    expect(raw.serviceJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: job.id, status: 'IN_PROGRESS', updatedAt: expected }),
      data: expect.objectContaining({ status: 'COMPLETED', updatedAt: new Date('2026-09-20T13:00:00.001Z') }),
    }));
    expect(raw.auditLog.create).toHaveBeenCalledOnce();
    expect(raw.chatRoom.updateMany).toHaveBeenCalledWith({ where: { id: job.chatRoomId, isActive: true }, data: { isActive: false } });
    expect(raw.notification.create).toHaveBeenCalledOnce();
    expect(result).toEqual({ job, notificationIds: ['notice-1'] });
  });

  it('fails the exact-generation CAS loser before any receipt, notification, or chat mutation', async () => {
    const { tx, raw, expected } = fakeTx(0);
    await expect(transitionServiceJob(tx, {
      jobId: 'job-1',
      actorUserId: 'provider-user',
      expectedUpdatedAt: expected,
      from: 'IN_PROGRESS',
      to: 'COMPLETED',
      action: 'SERVICE_JOB_COMPLETED',
      closeChatRoomId: 'room-1',
    })).rejects.toMatchObject({ statusCode: 409, code: 'SERVICE_JOB_CHANGED' });
    expect(raw.serviceJob.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(raw.auditLog.create).not.toHaveBeenCalled();
    expect(raw.notification.create).not.toHaveBeenCalled();
    expect(raw.chatRoom.updateMany).not.toHaveBeenCalled();
  });
});
