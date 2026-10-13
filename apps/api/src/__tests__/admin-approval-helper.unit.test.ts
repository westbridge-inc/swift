import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
vi.mock('../plugins/prisma', () => ({ runWithoutTenant: (fn: () => unknown) => fn() }));
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';

function fixture() {
  let tenant = 'tenant-a';
  const userCreate = vi.fn().mockResolvedValue({ id: 'second-admin' });
  const sessionCreate = vi.fn().mockResolvedValue({});
  const deleteUsers = vi.fn().mockResolvedValue({ count: 1 });
  const sessions = vi.fn().mockResolvedValue([{ userId: 'second-admin' }]);
  const app = {
    inject: vi.fn(async (opts: { url: string; headers?: Record<string, string> }) => opts.url.includes('/decide') || opts.headers?.['x-swift-approval']
      ? { statusCode: 200, json: () => ({ success: true }) }
      : { statusCode: 202, json: () => ({ error: { code: 'APPROVAL_REQUIRED', details: { approvalId: 'ask' } } }) }),
    jwt: { sign: vi.fn(() => 'second-token') },
    prisma: {
      privilegedApproval: { findUnique: vi.fn(async () => ({ tenantId: tenant })), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      user: { create: userCreate, deleteMany: deleteUsers },
      session: { create: sessionCreate, findMany: sessions, deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      admin: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      customer: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    },
  } as unknown as FastifyInstance;
  return { app, userCreate, sessionCreate, deleteUsers, sessions, setTenant: (value: string) => { tenant = value; } };
}
const ask = (app: FastifyInstance) => injectWithApproval(app, { method: 'POST', url: '/money' });

describe('second-approver fixtures', () => {
  it('retries a duplicate phone with a fresh candidate', async () => {
    const f = fixture();
    f.userCreate.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['phone'] } });
    await expect(ask(f.app)).resolves.toBeTruthy();
    expect(f.userCreate).toHaveBeenCalledTimes(2);
    expect(f.userCreate.mock.calls[0]![0].data.phone).not.toBe(f.userCreate.mock.calls[1]![0].data.phone);
    await cleanupSecondApprovers(f.app);
  });
  it('does not retry a different constraint failure', async () => {
    const f = fixture();
    const error = { code: 'P2002', meta: { target: ['email'] } };
    f.userCreate.mockRejectedValueOnce(error);
    await expect(ask(f.app)).rejects.toBe(error);
    expect(f.userCreate).toHaveBeenCalledTimes(1);
    await expect(cleanupSecondApprovers(f.app)).resolves.toBeUndefined();
  });
  it('cleans the successful tenant even when another cached approver failed', async () => {
    const f = fixture();
    f.userCreate.mockRejectedValueOnce(new Error('fixture creation unavailable'));
    await expect(ask(f.app)).rejects.toThrow('fixture creation unavailable');
    f.setTenant('tenant-b');
    await ask(f.app);
    await expect(cleanupSecondApprovers(f.app)).resolves.toBeUndefined();
    expect(f.deleteUsers).toHaveBeenCalledWith({ where: { id: { in: ['second-admin'] } } });
  });
  it('cleans a created user even when creating its session failed', async () => {
    const f = fixture();
    f.sessionCreate.mockRejectedValueOnce(new Error('session creation unavailable'));
    f.sessions.mockResolvedValueOnce([]);
    await expect(ask(f.app)).rejects.toThrow('session creation unavailable');
    await expect(cleanupSecondApprovers(f.app)).resolves.toBeUndefined();
    expect(f.deleteUsers).toHaveBeenCalledWith({ where: { id: { in: ['second-admin'] } } });
  });
});
