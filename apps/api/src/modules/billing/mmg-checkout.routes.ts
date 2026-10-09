import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MmgCheckoutIntent, Prisma, PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { runAsSystem } from '../../plugins/tenant-context';
import { mmgCheckoutEventsCounter } from '../../plugins/observability';
import {
  MERCHANT_TRANSACTION_ID_SHAPE,
  describeShape,
  getMmgCheckoutProvider,
  mmgCheckoutEnabled,
  type MmgCheckoutProvider,
} from '../../providers/mmg/mmg-checkout';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { BillingService } from './billing.service';
import { MmgCheckoutService, type CheckoutStatus, type CheckoutView, type ReturnState } from './mmg-checkout.service';
import { clientPlatform, feePayActions, mmgCheckoutLive, type ClientPlatform, type PayAction } from './fee-pay-actions';
import { readReopenableMmgCheckout, type ReopenableMmgCheckout } from './mmg-checkout-reopen';
import { partnerReceiptIds } from './mmg-checkout-receipt';
import { readFeePaymentDecision } from './fee-payment-authority';
import { subscriptionPayer } from '../subscription/mover-fee-authority';
import {
  MAX_REPLY_VALUES,
  MAX_REPLY_VALUE_CHARS,
  MMG_RESULT_CODES,
  openReply,
  outcomeHint,
  redactReply,
  replyCodeClass,
  resultCodeOf,
} from './mmg-checkout-reply';

// ---------------------------------------------------------------------------
// The MMG weekly-fee checkout ROUTES [mmg checkout 3/6] — MMG-CHECKOUT-API.md
// sections 2-6, the contract the phone and web fee pages already call.
//
//   POST /api/v1/{vendor|rider|driver}/subscription/mmg-checkout      start one
//   GET  /api/v1/{vendor|rider|driver}/subscription/mmg-checkout/:ref follow it
//   GET  /api/v1/{family}/subscription   gains payActions, latestMmgCheckout,
//                                        recentCheckouts, reopenableMmgCheckout (feeCheckoutPayload)
//   POST /api/v1/billing/mmg-checkout/return   the web return page forwards
//                                              MMG's reply here (success AND
//                                              failure arrive on one URL)
//   POST /api/v1/billing/mmg-checkout/notify   MMG's own servers, if any
//
// Every door stays behind MMG_CHECKOUT_ENABLED (default off): with the flag
// off the partner routes refuse or answer 404, the payload carries both pay
// actions as `off`, and the public routes answer neutrally without touching
// the database. The service underneath is #1393's MmgCheckoutService; these
// routes call it and add nothing to its rules: the partner who owns the
// subscription is the only one who may start or read a checkout (anyone else
// is 404 or 403 from the family's own gate), and a reply from MMG is a
// pointer that only prompts the server's own lookup — never a credit.
//
// The Pay button (`MMG_CHECKOUT` live) also needs what feePayActions does not
// express: #1393's shared confirmation authority allowing a NEW payment (none
// of this fee's payments is being confirmed, and the billing clock covers the
// subscription), and a payer in a production tenant: the store-review demo
// never opens a real MMG page.
// ---------------------------------------------------------------------------

/** Per-partner: twenty taps a minute is a stuck finger, not a partner. */
export const MMG_CHECKOUT_START_RATE = { max: 20, timeWindow: '1 minute' } as const;
/** Per source: the web server forwards every partner's return from ONE address, so this is generous and still a ceiling. */
export const MMG_CHECKOUT_RETURN_RATE = { max: 120, timeWindow: '1 minute' } as const;
export const MMG_CHECKOUT_NOTIFY_RATE = { max: 60, timeWindow: '1 minute' } as const;
/** 16 values of 4096 characters as JSON, with room for the envelope. */
export const MMG_CHECKOUT_RETURN_BODY_LIMIT = 96 * 1024;
/** The contract: JSON or a form of up to 16 KB. */
export const MMG_CHECKOUT_NOTIFY_BODY_LIMIT = 16 * 1024;
/** Everything the return page may render (its `words`); the API never answers more. */
export const RETURN_STATES = ['CONFIRMED', 'CONFIRMING', 'NOT_PAID', 'UNKNOWN'] as const satisfies readonly ReturnState[];

/** Over a limit is the contract's `429 RATE_LIMITED`, with the wait in seconds. */
const rateLimited = {
  errorResponseBuilder: (_request: FastifyRequest, context: { ttl: number }) =>
    new AppError(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute and try again.', { retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)) }),
};

/** [Sol · #1404] The public doors are limited per SOURCE: the proxy-resolved
 *  address (Fastify's trustProxy, never a raw X-Forwarded-For), the same
 *  bucket an anonymous caller gets from the global key. Never the global
 *  key's per-user bucket, which a bearer token selects: one source rotating
 *  signed-in principals would multiply its allowance. */
const perSource = { keyGenerator: (request: FastifyRequest) => request.ip };

const LATEST_WINDOW_MS = 24 * 3_600_000;
const RECENT_CHECKOUTS = 10;
const REF_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const OFF_ACTIONS: PayAction[] = [{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }];

// ---------------------------------------------------------------------------
// The runtime: one service and one checkout provider, shared by every family.
// Tests decorate the app with their own (a sandbox and a scripted lookup);
// the server builds the default lazily, on the first request that needs it.
// ---------------------------------------------------------------------------

export const MMG_CHECKOUT_RUNTIME_DECORATION = 'mmgCheckoutRuntime';

export interface MmgCheckoutRuntime {
  service: MmgCheckoutService;
  /** The same provider the service verifies with: what a reply is opened with here. */
  checkout: () => MmgCheckoutProvider;
  notifications: NotificationService;
}

export function mmgCheckoutRuntimeOf(app: FastifyInstance): MmgCheckoutRuntime {
  if (app.hasDecorator(MMG_CHECKOUT_RUNTIME_DECORATION)) {
    return (app as unknown as Record<string, MmgCheckoutRuntime>)[MMG_CHECKOUT_RUNTIME_DECORATION]!;
  }
  const notifications = new NotificationService(app.prisma, app.io);
  const checkout = () => getMmgCheckoutProvider();
  const billing = new BillingService(app.prisma, notifications, getPaymentProvider());
  return { service: new MmgCheckoutService(app.prisma, billing, notifications, { checkout }), checkout, notifications };
}

// ---------------------------------------------------------------------------
// The subscription payload's additive checkout fields (section 3).
// ---------------------------------------------------------------------------

export interface FeeCheckoutPayload {
  payActions: PayAction[];
  latestMmgCheckout: CheckoutView | null;
  recentCheckouts: CheckoutView[];
  reopenableMmgCheckout: ReopenableMmgCheckout | null;
}

function checkoutView(row: MmgCheckoutIntent, subscriptionStatus: SubscriptionStatus): CheckoutView {
  return {
    ref: row.id,
    status: row.status as CheckoutStatus,
    amountGyd: Number(row.amount),
    currencyCode: 'GYD',
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    subscriptionStatus,
    // [MMG support lookup] The partner's receipt: our reference always, MMG's once CONFIRMED.
    ...partnerReceiptIds(row),
  };
}

/**
 * [store review] Whether the payer (#1393's: the rider's or driver's user, or
 * the store owner's) is in a PRODUCTION tenant. The store-review demo (REVIEW)
 * and crawler (CRAWLER) tenants are fiction with no money rail: their partners
 * never open a real MMG page.
 */
async function payerIsProduction(prisma: PrismaClient, subscriptionId: string): Promise<boolean> {
  const payer = await subscriptionPayer(prisma, subscriptionId);
  const tenant = await prisma.tenant.findUnique({ where: { id: payer.tenantId }, select: { kind: true } });
  return tenant?.kind === 'PRODUCTION';
}

/**
 * payActions for one subscription: feePayActions (configuration, platform,
 * amount) and, before MMG_CHECKOUT may be live, a payer in a production tenant
 * and #1393's read-only decision for a NEW payment. That decision is `off`
 * while any of this fee's payments is being confirmed (an MMG checkout open,
 * confirming, held or expired without an answer; a card payment pending or
 * unclear) and while no billing clock covers the subscription. Reading never
 * maps a clock, takes a hold or changes a payment.
 */
async function payActionsFor(
  prisma: PrismaClient,
  sub: Subscription,
  platform: ClientPlatform,
  checkout: () => MmgCheckoutProvider,
): Promise<PayAction[]> {
  const actions = await feePayActions(prisma, sub, platform, checkout);
  if (!actions.some((action) => action.id === 'MMG_CHECKOUT' && action.state === 'live')) return actions;
  const payable = (await payerIsProduction(prisma, sub.id)) && (await readFeePaymentDecision(prisma, sub.id)).allowed;
  return payable ? actions : actions.map((action): PayAction => (action.id === 'MMG_CHECKOUT' ? { id: 'MMG_CHECKOUT', state: 'off' } : action));
}

export interface PartnerCheckoutRoutes {
  /** Additive checkout fields GET /subscription gains, for this family's own subscription. */
  feePayload: (sub: Subscription, headers: Record<string, unknown>, now?: Date) => Promise<FeeCheckoutPayload>;
}

export interface PartnerCheckoutRouteOptions {
  /** The caller's OWN subscription after the family's own gate has run (an
   *  outsider throws 403 there; a partner still onboarding gets null). */
  subscriptionFor: (request: FastifyRequest) => Promise<Subscription | null>;
}

/**
 * The partner routes of one family (section 4-5), mounted under that family's
 * prefix so its own authentication and store-selection gates apply first.
 */
export function registerPartnerMmgCheckoutRoutes(app: FastifyInstance, options: PartnerCheckoutRouteOptions): PartnerCheckoutRoutes {
  let runtime: MmgCheckoutRuntime | null = null;
  const rt = () => (runtime ??= mmgCheckoutRuntimeOf(app));

  const feePayload = async (sub: Subscription, headers: Record<string, unknown>, now: Date = new Date()): Promise<FeeCheckoutPayload> => {
    if (!mmgCheckoutEnabled()) return { payActions: OFF_ACTIONS, latestMmgCheckout: null, recentCheckouts: [], reopenableMmgCheckout: null };
    const [payActions, rows] = await Promise.all([
      payActionsFor(app.prisma, sub, clientPlatform(headers), rt().checkout),
      app.prisma.mmgCheckoutIntent.findMany({ where: { subscriptionId: sub.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: RECENT_CHECKOUTS }),
    ]);
    const recentCheckouts = rows.map((row) => checkoutView(row, sub.status));
    const latestMmgCheckout = recentCheckouts.find((c) => Date.parse(c.createdAt) >= now.getTime() - LATEST_WINDOW_MS) ?? null;
    const reopenableMmgCheckout = latestMmgCheckout?.status === 'OPEN'
      && await mmgCheckoutLive(app.prisma, sub, clientPlatform(headers), rt().checkout)
      && await payerIsProduction(app.prisma, sub.id)
      ? await readReopenableMmgCheckout(app.prisma, sub.id, latestMmgCheckout.ref, now) : null;
    return { payActions, latestMmgCheckout, recentCheckouts, reopenableMmgCheckout };
  };

  /** POST …/subscription/mmg-checkout — the server prices it; the body is ignored. */
  app.post('/subscription/mmg-checkout', { preHandler: [app.authenticate], config: { rateLimit: { ...MMG_CHECKOUT_START_RATE, ...rateLimited } } }, async (request, reply) => {
    // The family's gate first: an outsider is 403 before any key or flag is looked at.
    const sub = await options.subscriptionFor(request);
    if (!sub) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'There is no subscription to pay.');
    if (!mmgCheckoutEnabled()) throw new AppError(409, 'PAY_ACTION_OFF', 'Paying with MMG is not available for this account here.');
    // [store review] A demo partner never reaches MMG: refused before any key, price or page.
    if (!(await payerIsProduction(app.prisma, sub.id))) {
      throw new AppError(409, 'PAY_ACTION_OFF', 'Paying with MMG is not available for this account here.');
    }
    const { created, checkout } = await rt().service.createCheckout({
      subscriptionId: sub.id,
      userId: request.user.userId,
      platform: clientPlatform(request.headers),
      clientKey: request.headers['idempotency-key'],
    });
    return reply.status(created ? 201 : 200).send({ success: true, data: checkout });
  });

  /** GET …/subscription/mmg-checkout/:ref — one answer, 404, for an unknown ref and for another partner's. */
  app.get<{ Params: { ref: string } }>('/subscription/mmg-checkout/:ref', { preHandler: [app.authenticate] }, async (request) => {
    const sub = await options.subscriptionFor(request);
    if (!sub || !mmgCheckoutEnabled() || !REF_SHAPE.test(request.params.ref)) {
      throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'There is no such checkout.');
    }
    return { success: true, data: await rt().service.getCheckout({ ref: request.params.ref, subscriptionId: sub.id }) };
  });

  return { feePayload };
}

// ---------------------------------------------------------------------------
// The public doors (section 6): rate-limited, body-capped, no session.
// ---------------------------------------------------------------------------

const paramValue = z.string().max(MAX_REPLY_VALUE_CHARS);
const returnBody = z.object({
  outcome: z.string().max(64),
  params: z.record(z.string().max(256), z.union([paramValue, z.array(paramValue).max(MAX_REPLY_VALUES)])),
}).refine(
  (body) => Object.values(body.params).reduce((n, value) => n + (Array.isArray(value) ? value.length : 1), 0) <= MAX_REPLY_VALUES,
  { message: `at most ${MAX_REPLY_VALUES} values` },
);

/** A form body's fields, bounded like the return page's: a repeated key becomes an array. */
function formFields(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  let count = 0;
  for (const [key, value] of new URLSearchParams(text)) {
    if (count >= MAX_REPLY_VALUES) break;
    if (key.length > 256 || value.length > MAX_REPLY_VALUE_CHARS) continue;
    count += 1;
    const previous = out[key];
    out[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return out;
}

/**
 * [DS635] MMG sends ONE reply token, as one string. A token named more than
 * once (a repeated query or form field arrives as an array; `token` and
 * `Token` are two) is ambiguous: it is refused before anything is opened,
 * looked up or written down.
 */
function ambiguousToken(params: Record<string, unknown>): boolean {
  const tokens = Object.entries(params).filter(([key]) => key.toLowerCase() === 'token');
  return tokens.length > 1 || tokens.some(([, value]) => Array.isArray(value));
}

/** Whatever MMG's notify carries: a JSON object's own values, or a parsed form. Anything else is nothing. */
function notifyParams(body: unknown, query: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const source of [query, body]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) out[key] = value;
  }
  return out;
}

export async function mmgCheckoutPublicRoutes(app: FastifyInstance): Promise<void> {
  // MMG's notify may be a form; the server has no form parser elsewhere, so
  // this one is scoped to these routes.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: MMG_CHECKOUT_NOTIFY_BODY_LIMIT }, (_request, body, done) => {
    try {
      done(null, formFields(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  let runtime: MmgCheckoutRuntime | null = null;
  const rt = () => (runtime ??= mmgCheckoutRuntimeOf(app));

  /** The web return page forwards MMG's reply, from either registered URL, with the path as `outcome`. */
  app.post('/return', { bodyLimit: MMG_CHECKOUT_RETURN_BODY_LIMIT, config: { rateLimit: { ...MMG_CHECKOUT_RETURN_RATE, ...rateLimited, ...perSource } } }, async (request) => {
    const body = returnBody.parse(request.body ?? {});
    if (!mmgCheckoutEnabled()) return { success: true, data: { state: 'UNKNOWN' satisfies ReturnState } };
    if (ambiguousToken(body.params)) {
      log().warn({ source: 'RETURN' }, '[MMG checkout] a reply token arrived more than once; refused as UNKNOWN');
      return { success: true, data: { state: 'UNKNOWN' satisfies ReturnState } };
    }
    const state = await observeReply(app, rt(), { source: 'RETURN', outcome: body.outcome, params: body.params });
    return { success: true, data: { state } };
  });

  /** MMG's own servers, if MMG calls one: JSON or a form, always 200, never a word about any account. */
  app.post('/notify', { bodyLimit: MMG_CHECKOUT_NOTIFY_BODY_LIMIT, config: { rateLimit: { ...MMG_CHECKOUT_NOTIFY_RATE, ...rateLimited, ...perSource } } }, async (request) => {
    if (mmgCheckoutEnabled()) {
      const params = notifyParams(request.body, request.query);
      if (ambiguousToken(params)) {
        log().warn({ source: 'NOTIFY' }, '[MMG checkout] a reply token arrived more than once; ignored');
        return { success: true };
      }
      await observeReply(app, rt(), { source: 'NOTIFY', outcome: 'notify', params }).catch((err) => {
        log().error({ err }, '[MMG checkout] a notify could not be processed; the poll will look again');
      });
    }
    return { success: true };
  });
}

/**
 * One reply, from either door. Opened with the same provider the service
 * verifies with, read for MMG's result code, then:
 *   - 3, 4, 5: MMG refused OUR request (secret key, merchant id, token). An
 *     alert for operators; the reply is written down and nothing else moves —
 *     not the checkout, not a lookup, never a credit.
 *   - everything else, and a reply with no code: the service decides
 *     (#1393; MMG-CHECKOUT-API.md, "Official response interpretation"): 0
 *     confirms only under the owner's six conditions, else is held for a
 *     person; 1, 2 and 6 are MMG's own "not paid" for the checkout; 7 is "not
 *     paid" unless MMG's lookup says paid. Nothing credits from a reply alone.
 */
async function observeReply(
  app: FastifyInstance,
  runtime: MmgCheckoutRuntime,
  input: { source: 'RETURN' | 'NOTIFY'; outcome: string; params: unknown },
): Promise<ReturnState> {
  let provider: MmgCheckoutProvider | null = null;
  try {
    provider = runtime.checkout();
  } catch {
    provider = null;
  }
  const reply = provider && provider.driver !== 'disabled' ? openReply(provider, input.params) : null;
  const code = reply ? resultCodeOf(reply) : null;
  if (reply && replyCodeClass(code) === 'ALERT') {
    await alertOnRefusedRequest(app, runtime, { source: input.source, outcome: input.outcome, reply, code: code as string });
    return 'UNKNOWN';
  }
  return runtime.service.observeReply({ source: input.source, outcome: input.outcome, params: input.params });
}

/** [I9] Written down first, under the checkout's own tenant when the reply names one of ours; then the page. */
async function alertOnRefusedRequest(
  app: FastifyInstance,
  runtime: MmgCheckoutRuntime,
  input: { source: 'RETURN' | 'NOTIFY'; outcome: string; reply: Record<string, unknown>; code: string },
): Promise<void> {
  await runAsSystem('mmg-checkout-reply', async () => {
    const named = input.reply['merchantTransactionId'];
    const intent = typeof named === 'string' && MERCHANT_TRANSACTION_ID_SHAPE.test(named.trim())
      ? await app.prisma.mmgCheckoutIntent.findUnique({ where: { merchantTransactionId: named.trim() } })
      : null;
    const failure = `RESULT_CODE_${input.code}`;
    await app.prisma.mmgCheckoutObservation.create({
      data: {
        ...(intent ? { tenantId: intent.tenantId } : {}),
        intentId: intent?.id ?? null,
        source: input.source,
        detail: outcomeHint(input.outcome),
        body: redactReply(input.reply) ?? {},
        shape: describeShape(input.reply) as Prisma.InputJsonValue,
        failure,
      },
    });
    mmgCheckoutEventsCounter.labels('reply_alert').inc();
    const meaning = MMG_RESULT_CODES[input.code] ?? 'undocumented';
    log().error(
      { checkoutId: intent?.id ?? null, resultCode: input.code, source: input.source },
      `[MMG checkout] MMG refused a checkout request: result code ${input.code} (${meaning}). Configuration or security: nothing was credited.`,
    );
    await notifyAdmins(app.prisma, runtime.notifications, {
      tenantId: intent?.tenantId ?? null,
      title: 'MMG checkout: request refused by MMG',
      body: `MMG answered result code ${input.code} (${meaning})${intent ? ` for checkout ${intent.id}` : ' for a reference that is not ours'}. `
        + 'This is a configuration or security problem with the checkout request, not a payment. Nothing was credited; the checkout was not changed.',
      data: { kind: 'billing_invariants', alert: 'mmg-checkout-reply-code', resultCode: input.code, checkoutId: intent?.id ?? null, source: input.source },
      // [#1393] Once per checkout and code, under the service's own key: a repeated or replayed reply
      // is written down again but pages nobody twice, whatever the checkout's state.
      ...(intent ? { dedupeKey: `mmg-checkout-reply-code:${intent.id}:${input.code}` } : {}),
    }).catch((err) => {
      log().error({ err, resultCode: input.code }, '[MMG checkout] the operators could not be paged about a refused request');
    });
  });
}
