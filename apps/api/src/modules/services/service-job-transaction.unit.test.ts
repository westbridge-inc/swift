import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, ServiceJob } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { transitionServiceJob } from './service-job-transition';

const mocks = vi.hoisted(() => ({
  bindTenantTransaction: vi.fn(),
}));

vi.mock('../../plugins/prisma', () => ({
  bindTenantTransaction: mocks.bindTenantTransaction,
}));

import {
  executeTenantBoundServiceJobTransaction,
  runTenantBoundServiceJobTransaction,
  type ServiceJobTransactionHost,
} from './service-job-transaction';

interface TransactionState {
  job: ServiceJob;
  auditActions: string[];
  chatActive: boolean;
  notificationIds: string[];
}

function initialState(): TransactionState {
  return {
    job: {
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
      updatedAt: new Date('2026-09-20T13:00:00.000Z'),
    },
    auditActions: [],
    chatActive: true,
    notificationIds: [],
  };
}

function copyState(state: TransactionState): TransactionState {
  return {
    job: { ...state.job },
    auditActions: [...state.auditActions],
    chatActive: state.chatActive,
    notificationIds: [...state.notificationIds],
  };
}

function rollbackModel(state: TransactionState, failAt?: 'audit' | 'chat' | 'notification') {
  const calls = { cas: 0 };
  const host = {
    $transaction: vi.fn(async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      const before = copyState(state);
      const tx = {
        serviceJob: {
          updateMany: vi.fn(async ({ where, data }: {
            where: { id: string; status: string; updatedAt: Date };
            data: { status: ServiceJob['status']; updatedAt: Date; completedAt?: Date };
          }) => {
            calls.cas += 1;
            if (
              state.job.id !== where.id
              || state.job.status !== where.status
              || state.job.updatedAt.getTime() !== where.updatedAt.getTime()
            ) return { count: 0 };
            state.job = { ...state.job, ...data };
            return { count: 1 };
          }),
          findUniqueOrThrow: vi.fn(async () => state.job),
        },
        auditLog: {
          create: vi.fn(async ({ data }: { data: { action: string } }) => {
            state.auditActions.push(data.action);
            if (failAt === 'audit') throw new Error('injected audit failure');
            return { id: 'audit-1' };
          }),
        },
        chatRoom: {
          updateMany: vi.fn(async () => {
            state.chatActive = false;
            if (failAt === 'chat') throw new Error('injected chat failure');
            return { count: 1 };
          }),
        },
        notification: {
          create: vi.fn(async () => {
            state.notificationIds.push('notice-1');
            if (failAt === 'notification') throw new Error('injected notification failure');
            return { id: 'notice-1' };
          }),
        },
      } as unknown as Prisma.TransactionClient;

      try {
        return await operation(tx);
      } catch (error) {
        state.job = before.job;
        state.auditActions = before.auditActions;
        state.chatActive = before.chatActive;
        state.notificationIds = before.notificationIds;
        throw error;
      }
    }),
  };
  return { host: host as unknown as ServiceJobTransactionHost, calls };
}

async function completeInTransaction(
  host: ReturnType<typeof rollbackModel>['host'],
  state: TransactionState,
) {
  return executeTenantBoundServiceJobTransaction(host, (tx) => transitionServiceJob(tx, {
    jobId: state.job.id,
    actorUserId: 'provider-user',
    expectedUpdatedAt: state.job.updatedAt,
    from: 'IN_PROGRESS',
    to: 'COMPLETED',
    data: { completedAt: new Date('2026-09-20T13:00:00.001Z') },
    action: 'SERVICE_JOB_COMPLETED',
    closeChatRoomId: state.job.chatRoomId,
    notices: [{
      userId: state.job.customerId,
      type: 'ORDER_UPDATE',
      title: 'Complete',
      body: 'Done',
      data: { kind: 'booking_completed', jobId: state.job.id },
    }],
    now: new Date('2026-09-20T13:00:00.001Z'),
  }));
}

describe('service-job interactive transaction tenant contract', () => {
  beforeEach(() => {
    mocks.bindTenantTransaction.mockReset();
  });

  it('binds the canonical tenant context before user locks or service-job queries', async () => {
    const events: string[] = [];
    mocks.bindTenantTransaction.mockImplementation(async () => {
      events.push('bind-tenant');
    });
    const raw = {
      $queryRaw: vi.fn(async () => {
        events.push('user-lock');
        return [];
      }),
      serviceJob: {
        updateMany: vi.fn(async () => {
          events.push('service-job-cas');
          return { count: 1 };
        }),
      },
    };
    const tx = raw as unknown as Prisma.TransactionClient;

    await runTenantBoundServiceJobTransaction(tx, async (boundTx) => {
      expect(boundTx).toBe(tx);
      await boundTx.$queryRaw`SELECT "id" FROM "users" FOR UPDATE`;
      await boundTx.serviceJob.updateMany({ where: { id: 'job-1' }, data: { status: 'QUOTED' } });
    });

    expect(mocks.bindTenantTransaction).toHaveBeenCalledOnce();
    expect(mocks.bindTenantTransaction).toHaveBeenCalledWith(tx);
    expect(events).toEqual(['bind-tenant', 'user-lock', 'service-job-cas']);
  });

  it('does not run any lifecycle operation when tenant binding fails', async () => {
    const bindingError = new Error('tenant bind failed');
    mocks.bindTenantTransaction.mockRejectedValue(bindingError);
    const operation = vi.fn();

    await expect(runTenantBoundServiceJobTransaction(
      {} as Prisma.TransactionClient,
      operation,
    )).rejects.toBe(bindingError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('denies a cross-tenant bind before the state CAS enters the transaction body', async () => {
    const state = initialState();
    const before = copyState(state);
    const { host, calls } = rollbackModel(state);
    mocks.bindTenantTransaction.mockRejectedValue(new AppError(
      403,
      'TENANT_SCOPE_VIOLATION',
      'The service job is outside the authenticated tenant.',
    ));

    await expect(completeInTransaction(host, state)).rejects.toMatchObject({
      statusCode: 403,
      code: 'TENANT_SCOPE_VIOLATION',
    });
    expect(calls.cas).toBe(0);
    expect(state).toEqual(before);
  });

  it.each(['audit', 'chat', 'notification'] as const)(
    'propagates an injected post-CAS %s failure through one transaction callback so the model rolls every row back',
    async (failAt) => {
      const state = initialState();
      const before = copyState(state);
      const { host, calls } = rollbackModel(state, failAt);
      mocks.bindTenantTransaction.mockResolvedValue(undefined);

      await expect(completeInTransaction(host, state)).rejects.toThrow(`injected ${failAt} failure`);
      expect(calls.cas).toBe(1);
      expect(state).toEqual(before);
    },
  );
});
