import { expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

// Explicitly included by vitest.home-projection.config.ts. The default API
// profile collects only *.test.ts and intentionally uses real Prisma clients.
it('the service-free profile refuses a real Prisma client before any connection', () => {
  expect(() => new PrismaClient()).toThrow('Home service-free profile forbids PrismaClient');
});
