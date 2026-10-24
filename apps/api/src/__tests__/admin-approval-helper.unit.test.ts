import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
vi.mock('../plugins/prisma', () => ({ runWithoutTenant: (fn: () => unknown) => fn() }));
vi.mock('./helpers/fixture-ids', () => ({ testPhone: () => 'synthetic-phone' }));
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';

// The suites' second approver is made once per tenant and removed by
// cleanupSecondApprovers. A setup that fails must not stop that clean-up:
// not another tenant's approver, and not the user row a failed session left.

function fixture() {
  let tenant = 'tenant-a';
  let next = 0;
  const userCreate = vi.fn(async () => ({ id: `second-admin-${++next}` }));
  const sessionCreate = vi.fn().mockResolvedValue({});
  const deleteUsers = vi.fn().mockResolvedValue({ count: 1 });
  const app = {
    inject: vi.fn(async (opts: { url: string; headers?: Record<string, string> }) => opts.url.includes('/decide') || opts.headers?.['x-swift-approval']
      ? { statusCode: 200, json: () => ({ success: true }) }
      : { statusCode: 202, json: () => ({ error: { code: 'APPROVAL_REQUIRED', details: { approvalId: 'ask' } } }) }),
    jwt: { sign: vi.fn(() => 'second-token') },
    prisma: {
      privilegedApproval: { findUnique: vi.fn(async () => ({ tenantId: tenant })), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      user: { create: userCreate, deleteMany: deleteUsers },
      session: { create: sessionCreate, deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      admin: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      customer: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    },
  } as unknown as FastifyInstance;
  return { app, userCreate, sessionCreate, deleteUsers, setTenant: (value: string) => { tenant = value; } };
}
const ask = (app: FastifyInstance) => injectWithApproval(app, { method: 'POST', url: '/money' });

describe('second-approver clean-up survives a failed setup', () => {
  it('cleans the tenant that worked even when another tenant\'s approver failed', async () => {
    const f = fixture();
    f.userCreate.mockRejectedValueOnce(new Error('fixture creation unavailable'));
    await expect(ask(f.app)).rejects.toThrow('fixture creation unavailable');
    f.setTenant('tenant-b');
    await ask(f.app);
    await expect(cleanupSecondApprovers(f.app)).resolves.toBeUndefined();
    expect(f.deleteUsers).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: ['second-admin-1'] } } });
  });

  it('cleans a created user whose session could not be made', async () => {
    const f = fixture();
    f.sessionCreate.mockRejectedValueOnce(new Error('session creation unavailable'));
    await expect(ask(f.app)).rejects.toThrow('session creation unavailable');
    await expect(cleanupSecondApprovers(f.app)).resolves.toBeUndefined();
    expect(f.deleteUsers).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: ['second-admin-1'] } } });
  });

  it('cleans every approver once when all setups worked, then has nothing left', async () => {
    const f = fixture();
    await ask(f.app);
    f.setTenant('tenant-b');
    await ask(f.app);
    await cleanupSecondApprovers(f.app);
    expect(f.deleteUsers).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: ['second-admin-1', 'second-admin-2'] } } });
    await cleanupSecondApprovers(f.app);
    expect(f.deleteUsers).toHaveBeenCalledTimes(1);
  });
});
