import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type {} from '@fastify/rate-limit';
import type {} from '@fastify/multipart';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { BillingService } from '../modules/billing/billing.service';
import { registerErrorHandler } from '../middleware/error-handler';
// [#1393] The rider and driver routes resolve the payer's one shared weekly-fee
// subscription (proved against PostgreSQL in mover-fee-authority.test.ts). This
// suite grades the step-up gate, so that resolution is doubled here.
vi.mock('../modules/subscription/mover-fee-authority', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modules/subscription/mover-fee-authority')>(),
  moverFeePayer: async (_db: unknown, userId: string) => ({ userId, tenantId: 'swift-default' }),
  readMoverFeeSubscription: async () => ({ subscription: { id: 'safeb-subscription' } }),
}));

afterEach(() => vi.restoreAllMocks());
describe('billing-method mutations require the same stepped-up session', () => {
  it.each(['driver', 'rider', 'vendor'] as const)('%s gates CASH, MOBILE_MONEY and NONE without changing declaration semantics', async (role) => {
    const db: any = {
      driver: { findUnique: async () => ({ id: 'safeb-driver' }) },
      rider: { findUnique: async () => ({ id: 'safeb-rider' }) },
      vendorOwner: { findUnique: async () => ({ id: 'safeb-owner', vendors: [{ id: 'safeb-store' }] }) },
      subscription: { findFirst: vi.fn(async () => ({ id: 'safeb-subscription' })) },
    };
    const set = vi.spyOn(BillingService.prototype, 'setBillingRail').mockResolvedValue({ billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: '+5920000000' } as never);
    const stop = vi.spyOn(BillingService.prototype, 'stopBilling').mockResolvedValue({ billingMethod: 'CASH', mmgPayerMsisdn: null } as never);
    const grants = new Set<string>();
    const app = Fastify();
    app.decorate('prisma', db);
    app.decorate('redis', { exists: async (key: string) => grants.has(key) ? 1 : 0 } as never);
    app.decorate('io', { to: () => ({ emit: vi.fn() }) } as never);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: 'safeb-account', role: role.toUpperCase() };
      request.authSessionId = request.headers['x-synthetic-session'] ?? 'safeb-session-a';
    });
    registerErrorHandler(app);
    try {
      await app.register({ driver: driverRoutes, rider: riderRoutes, vendor: vendorRoutes }[role], { prefix: `/${role}` });
      for (const method of ['CASH', 'MOBILE_MONEY', 'NONE']) {
        const payload = { method, mmgPayerMsisdn: '+5920000000' };
        const cold = await app.inject({ method: 'PUT', url: `/${role}/subscription/billing-method`, payload });
        expect(cold.statusCode, cold.body).toBe(403);
        expect(cold.json().error.code).toBe('STEP_UP_REQUIRED');
      }
      expect(set).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
      grants.add('stepup:ok:safeb-session-a');
      const foreign = await app.inject({ method: 'PUT', url: `/${role}/subscription/billing-method`, headers: { 'x-synthetic-session': 'safeb-session-b' }, payload: { method: 'NONE' } });
      expect(foreign.statusCode, foreign.body).toBe(403); expect(stop).not.toHaveBeenCalled();
      for (const method of ['CASH', 'MOBILE_MONEY', 'NONE']) {
        const accepted = await app.inject({ method: 'PUT', url: `/${role}/subscription/billing-method`, payload: { method, mmgPayerMsisdn: '+5920000000' } });
        expect(accepted.statusCode, accepted.body).toBe(200);
      }
      expect(set).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });
});
