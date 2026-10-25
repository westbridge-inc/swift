import { afterEach, expect, vi } from 'vitest';
import { Socket } from 'node:net';

// Fail before a service can be contacted if a DB-backed test ever slips into
// this allowlist. Keep the real enums/Decimal/query types for explicit fakes.
vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  return { ...actual, PrismaClient: class {
    constructor() { throw new Error('Home service-free profile forbids PrismaClient'); }
  } };
});
vi.mock('ioredis', () => {
  class ForbiddenRedis {
    constructor() { throw new Error('Home service-free profile forbids Redis clients'); }
  }
  return { default: ForbiddenRedis, Redis: ForbiddenRedis };
});
const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
  throw new Error('Home service-free profile forbids network connections');
});

const fetch = vi.fn(() => { throw new Error('Home service-free profile forbids fetch'); });
vi.stubGlobal('fetch', fetch);
afterEach(() => {
  // A swallowed network error must still fail the suite, never become a pass.
  expect(connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
