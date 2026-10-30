import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BillingService } from '../billing/billing.service';
import { NotificationService } from '../notification/notification.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { registerPartnerMmgCheckoutRoutes } from '../billing/mmg-checkout.routes';
import { registerPartnerCardRoutes, withCardPayAction } from '../billing/card-rail.routes';
import { requireStepUp } from '../auth/step-up';
import { ReviewDemoMoneyRefusedError } from '../review/demo-policy';
import { NotFoundError } from '../../utils/errors';
import { ensureProFeeBorn, proFeeAcknowledged, proFeeQuote, proFeeStanding, recordProFeeAck } from './pro-fee';
import { weeklyFeeTerms, WEEKLY_FEE_ACK_VERSION } from '../partner/weekly-fee-ack';
import { consentSurfaceOf } from '../legal/consent-surface';

// ---------------------------------------------------------------------------
// [BILL-PRO PR4 · owner A4] /api/v1/provider: an independent service provider's (a pro's) own weekly fee, the routes a
// store's and a mover's fee already have, for the pro's own subscription (born by services/pro-fee.ts behind
// PRO_WEEKLY_FEE; none exists while it is off, so every route here answers "no fee" until then):
//  - GET  /subscription                    the fee, its Swift Number, what is due, where it stands (feeStatus),
//                                          how to pay (payActions: MMG's checkout page only), receipts, and the
//                                          pro's standing (listed / why not). No operability gate (PINV-8): a pro
//                                          who owes must always see what to pay.
//  - PUT  /subscription/billing-method     CASH (prepaid) or NONE (stop the plan; the paid week still runs), after a
//                                          step-up, as for stores and movers.
//  - POST /weekly-fee-ack                  [owner B3] "I understand the weekly fee", as a pro: the words' version and
//                                          the amount the pro saw (the services rate now), recorded in the consent
//                                          ledger as at partner sign-up. With the Business Agreement accepted, it may
//                                          make the fee due (born now, its 14-day trial starting today).
//  - MMG checkout start / reopen / follow  registerPartnerMmgCheckoutRoutes: credited only after MMG's own lookup.
//  - card routes                           registerPartnerCardRoutes (card rail v2 stays behind CARD_RAIL_V2, off).
// Only the pro's OWN subscription is ever read or paid here. A pro covered by their Services store's fee (one fee,
// owner B1) pays it on the store's weekly-fee screen; this route then says so (`coveredBy: 'STORE'`).
// ---------------------------------------------------------------------------

export async function providerFeeRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [app.authenticate] };
  const billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());

  /** The pro's own fee subscription; 404 when the person has no provider profile. */
  const proOf = async (request: FastifyRequest) => {
    const pro = await app.prisma.serviceProvider.findUnique({ where: { userId: request.user.userId }, select: { id: true, subscription: true } });
    if (!pro) throw new NotFoundError('ServiceProvider');
    return pro;
  };
  const feeSubscriptionFor = async (request: FastifyRequest) => (await proOf(request)).subscription;
  const mmgCheckout = registerPartnerMmgCheckoutRoutes(app, { subscriptionFor: feeSubscriptionFor });
  const cardRail = registerPartnerCardRoutes(app, { subscriptionFor: feeSubscriptionFor });

  app.get('/subscription', auth, async (request) => {
    const pro = await proOf(request);
    const now = new Date();
    const standing = await proFeeStanding(app.prisma, request.user.userId, now);
    const coveredBy = standing.required && standing.source === 'STORE' ? 'STORE' as const : null;
    // [owner B3] The fee words and the amount the pro is asked to tick (until they have).
    const quote = await proFeeQuote(app.prisma, request.user.userId);
    const feeTerms = { ...weeklyFeeTerms(), amount: quote.amount, currencyCode: quote.currencyCode, acknowledged: await proFeeAcknowledged(app.prisma, request.user.userId) };
    const sub = pro.subscription;
    if (!sub) return { success: true, data: null, standing, coveredBy, feeTerms };
    const { sanDisplay } = await import('../billing/san.service');
    const { payInfo } = await import('../billing/agent-cash.service');
    const { feeStatusFor } = await import('../billing/fee-status');
    const fee = await payInfo(app.prisma, sub);
    const payments = await app.prisma.subscriptionPayment.findMany({ where: { subscriptionId: sub.id }, orderBy: { createdAt: 'desc' }, take: 20 });
    return {
      success: true,
      data: {
        ...sub,
        payments,
        ...(await sanDisplay(app.prisma, sub)),
        ...fee,
        feeStatus: await feeStatusFor(app.prisma, sub, fee, now),
        ...withCardPayAction(await mmgCheckout.feePayload(sub, request.headers, now), await cardRail.subscriptionFields(sub, request)),
        feeReceipts: await (await import('../billing/fee-receipt')).feeReceiptsFor(app.prisma, sub.id),
        // The one predicate (pro-fee.ts): listed and taking new work exactly when this is true.
        isActive: standing.operable && sub.currentPeriodEnd > now,
      },
      standing,
      coveredBy,
      feeTerms,
    };
  });

  app.post('/weekly-fee-ack', auth, async (request) => {
    const body = z.object({
      version: z.literal(WEEKLY_FEE_ACK_VERSION).or(z.string().max(16)),
      amount: z.number().nonnegative(),
      currencyCode: z.string().length(3),
    }).parse(request.body);
    await proOf(request);
    await recordProFeeAck(app.prisma, { userId: request.user.userId, ack: body, surface: consentSurfaceOf(request), ip: request.ip });
    // Never fails the tick: a failed birth is logged and retried by the reconcile sweep.
    await ensureProFeeBorn(app.prisma, request.user.userId);
    return { success: true, data: { acknowledged: true, standing: await proFeeStanding(app.prisma, request.user.userId) } };
  });

  app.put('/subscription/billing-method', auth, async (request) => {
    const body = z.object({ method: z.enum(['CASH', 'NONE']) }).parse(request.body);
    // [REVIEW-PARTNER · DL-5] No weekly fee in the fiction: no rail to choose, no step-up to run.
    if (request.tenantKind === 'REVIEW') throw new ReviewDemoMoneyRefusedError();
    await requireStepUp(app, request);
    const sub = (await proOf(request)).subscription;
    if (!sub) throw new NotFoundError('Subscription');
    const updated = body.method === 'NONE'
      ? await billing.stopBilling(sub.id, request.user.userId)
      : await billing.setBillingRail(sub.id, body.method);
    return { success: true, data: { billingMethod: updated.billingMethod } };
  });
}
