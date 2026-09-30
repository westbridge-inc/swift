import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { BillingService } from '../modules/billing/billing.service';
import type { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider, type PaymentProvider } from '../providers/payment/payment-provider';
import { AdCheckoutService } from '../modules/ads/checkout.service';
import type { Server } from 'socket.io';

afterEach(() => vi.unstubAllEnvs());

describe('card rail OFF at the billing boundary', () => {
  it('preserves the production refusal of hosted ad card checkout', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PAYMENT_PROVIDER', 'disabled');
    vi.stubEnv('CARD_RAIL_KILL', '1');
    const findUnique = vi.fn();
    const checkout = new AdCheckoutService({ adCampaign: { findUnique } } as unknown as PrismaClient, {} as Server);
    vi.stubEnv('NODE_ENV', 'production');
    await expect(checkout.checkout('synthetic', 'POWERTRANZ'))
      .rejects.toMatchObject({ statusCode: 503, code: 'ADS_PAYMENT_PROVIDER_UNAVAILABLE' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each(['CARD', 'card', '', 'unknown'])('refuses runtime rail selection %s before any write', async (method) => {
    vi.stubEnv('PAYMENT_PROVIDER', 'disabled');
    vi.stubEnv('CARD_RAIL_KILL', '1');
    const update = vi.fn(async () => ({ currencyCode: 'GYD' }));
    const billing = new BillingService(
      { subscription: { update }, billingEvent: { create: vi.fn() } } as unknown as PrismaClient,
      {} as NotificationService,
      {} as PaymentProvider,
    );
    await expect(billing.setBillingRail('synthetic', method as 'CASH'))
      .rejects.toMatchObject({ code: 'BILLING_RAIL_UNAVAILABLE', statusCode: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it('defers legacy card billing even if the kill switch changes after boot', async () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'disabled');
    vi.stubEnv('CARD_RAIL_KILL', '0');
    const chargeToken = vi.fn();
    const findUnique = vi.fn(async () => ({ status: 'CAPTURED', id: 'synthetic-intent' }));
    const billing = new BillingService(
      {
        prepaidBalance: { findUnique: vi.fn(async () => null) },
        // R13: attemptCharge reads the MMG approval-hold gate first; null = no hold.
        subscriptionPayment: { findUnique, findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient,
      {} as NotificationService,
      { chargeToken } as unknown as PaymentProvider,
    );
    // Exercise the real charge decision without opening services or manufacturing
    // the unrelated billing-cycle database graph.
    const attempt = billing as unknown as {
      attemptCharge: (sub: { id: string; billingMethod: string; paymentToken: string; nextBillingDate: Date }, amount: number) => Promise<unknown>;
    };
    await expect(attempt.attemptCharge({ id: 'synthetic', billingMethod: 'CARD', paymentToken: 'synthetic', nextBillingDate: new Date('2026-09-01') }, 1))
      .resolves.toEqual({ ok: false, deferred: true });
    expect(chargeToken).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not turn a disabled provider refusal into a billing failure', async () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'stripe');
    vi.stubEnv('CARD_RAIL_KILL', '0');
    const billing = new BillingService(
      {
        prepaidBalance: { findUnique: vi.fn(async () => null) },
        // R13: attemptCharge reads the MMG approval-hold gate first; null = no hold.
        subscriptionPayment: {
          findUnique: vi.fn(async () => ({ status: 'UNKNOWN', id: 'synthetic-intent' })),
          findFirst: vi.fn(async () => null),
        },
      } as unknown as PrismaClient,
      {} as NotificationService,
      {
        lookupCharge: vi.fn(async () => ({ status: 'not_found' })),
        chargeToken: vi.fn(async () => ({ status: 'failed', providerRef: '', code: 'CARD_RAIL_DISABLED' })),
      } as unknown as PaymentProvider,
    );
    const attempt = billing as unknown as { attemptCharge: (sub: object, amount: number) => Promise<unknown> };
    await expect(attempt.attemptCharge({
      id: 'synthetic', billingMethod: 'CARD', paymentToken: 'synthetic',
      nextBillingDate: new Date('2026-09-01'), failedAttempts: 0,
    }, 1)).resolves.toEqual({ ok: false, deferred: true });
  });

  it('leaves a refused reconciliation retry unresolved without dunning', async () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'stripe');
    vi.stubEnv('CARD_RAIL_KILL', '0');
    const now = new Date('2026-09-01T00:00:00Z');
    const billing = new BillingService(
      {
        subscription: { findUnique: vi.fn(async () => ({ id: 'synthetic', paymentToken: 'synthetic', currencyCode: 'GYD' })) },
        subscriptionPayment: {
          findMany: vi.fn(async () => [{ id: 'synthetic-intent', subscriptionId: 'synthetic', clientKey: 'synthetic', periodStart: now, amount: 1, createdAt: now }]),
          updateMany: vi.fn(async () => ({})),
          findFirst: vi.fn(async () => ({ createdAt: now })),
          count: vi.fn(async () => 1),
        },
      } as unknown as PrismaClient,
      {} as NotificationService,
      {
        lookupCharge: vi.fn(async () => ({ status: 'not_found' })),
        chargeToken: vi.fn(async () => ({ status: 'failed', providerRef: '', code: 'CARD_RAIL_DISABLED' })),
      } as unknown as PaymentProvider,
    );
    const terminalize = vi.fn(async () => true);
    (billing as unknown as { terminalizeFailedPayment: typeof terminalize }).terminalizeFailedPayment = terminalize;
    await expect(billing.reconcileUnknownCardCharges(now)).resolves.toMatchObject({ stillUnknown: 1, declined: 0, expired: 0, settled: 0 });
    expect(terminalize).not.toHaveBeenCalled();
  });

  it('the disabled factory preserves even expired legacy unknown intents without provider contact', async () => {
    vi.stubEnv('PAYMENT_PROVIDER', 'disabled');
    vi.stubEnv('CARD_RAIL_KILL', '1');
    const createdAt = new Date('2026-09-01T00:00:00Z');
    const now = new Date('2026-09-03T00:00:00Z');
    const billing = new BillingService(
      {
        subscription: { findUnique: vi.fn(async () => ({ id: 'synthetic', paymentToken: 'synthetic' })) },
        subscriptionPayment: {
          findMany: vi.fn(async () => [{ id: 'synthetic-intent', subscriptionId: 'synthetic', clientKey: 'synthetic', periodStart: createdAt, amount: 1, createdAt }]),
          updateMany: vi.fn(async () => ({})),
          findFirst: vi.fn(async () => ({ createdAt })),
          count: vi.fn(async () => 1),
        },
      } as unknown as PrismaClient,
      {} as NotificationService,
      getPaymentProvider(),
    );
    const terminalize = vi.fn();
    (billing as unknown as { terminalizeFailedPayment: typeof terminalize }).terminalizeFailedPayment = terminalize;
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider contact'));
    try {
      await expect(billing.reconcileUnknownCardCharges(now)).resolves.toMatchObject({ stillUnknown: 1, declined: 0, expired: 0, settled: 0, oldestMinutes: 2880 });
      expect(terminalize).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
