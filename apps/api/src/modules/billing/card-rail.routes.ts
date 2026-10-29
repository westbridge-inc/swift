import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CardSessionStatus, PrismaClient, Subscription } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { isProduction } from '../../utils/runtime-mode';
import { cardEnrollEnabled, cardRailV2DrainEnabled, cardRailV2Enabled } from '../../utils/card-rail';
import { formatAmount, fromMinor } from '../../utils/currency-amount';
import { getTenantId, runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { requireStepUp } from '../auth/step-up';
import { ReviewDemoMoneyRefusedError } from '../review/demo-policy';
import { NotificationService } from '../notification/notification.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { getCardRailProvider } from '../../providers/card/card-rail-factory';
import type { CardRailProvider, CardRailSource } from '../../providers/card/card-provider';
import type { OnAudit } from '../../lib/audit-writer';
import { SIMULATOR_PAGE, SimulatorCardRailProvider, SimulatorRefusal } from '../../providers/card/simulator-provider';
import { PowerTranzCardRailProvider, type PowerTranzHostedPage } from '../../providers/card/powertranz-provider';
import { BillingService } from './billing.service';
import { CARD_ON_FILE_CONSENT_VERSION, CARD_RESOLVE_ACTIONS, CARD_SANDBOX_TEST_LABEL, CardRailService, INSTRUMENT_DTO_SELECT, cardTestLabel, type CardSessionDto, type PaymentInstrumentDto } from './card-rail.service';
import { CARD_OFF, cardPayAction, cardSessionsAllowed, type CardPayAction } from './card-pay-action';
import { clientPlatform, type PayAction } from './fee-pay-actions';
import { LOCK_ICON, SWIFT_PAGE_HEADER, buttonLink, cardPageHtml, escapeHtml, testBanner, toneChip, type CardPageTone } from './card-page-look';

// ---------------------------------------------------------------------------
// [PT-2] The card rail v2 ROUTES (CARD-CHECKOUT-API.md). They call PT-1's
// CardRailService and add nothing to its money rules:
//
//   GET    /api/v1/{family}/subscription/cards                  cards + the CARD pay action
//   DELETE /api/v1/{family}/subscription/cards/:cardId          remove a card (step-up)
//   POST   /api/v1/{family}/subscription/card-sessions          open Add card / Pay now (Idempotency-Key)
//   GET    /api/v1/{family}/subscription/card-sessions/:id      follow one
//   GET|POST /api/v1/billing/card/return                        the provider's return (public)
//   GET|POST /api/v1/billing/card/simulator/:ref                the simulator's test page (never production)
//   GET    /api/v1/billing/card/pay/:ref                        [PT-4] Swift's page around the bank's card form
//   GET    /api/v1/admin/billing/card-sessions[/:id]            admin read views
//   GET    /api/v1/admin/billing/subscriptions/:id/cards
//
// The partner routes are mounted INSIDE each family's plugin so that family's
// own authentication and selection gate runs first: an outsider is 401/403
// before any key, flag, body or id is looked at. The return is an
// observation that never credits by itself [C5]: only the provider's
// server-side answer (CardRailService.confirm) enrols a card or books a week.
// ---------------------------------------------------------------------------

/** Per partner: twenty taps a minute is a stuck finger, not a partner. */
export const CARD_SESSION_START_RATE = { max: 20, timeWindow: '1 minute' } as const;
/** Per source address: a browser returns once per page; this is a ceiling, not a budget. */
export const CARD_RETURN_RATE = { max: 60, timeWindow: '1 minute' } as const;
export const CARD_SIMULATOR_RATE = { max: 60, timeWindow: '1 minute' } as const;
/** What a return may carry: query plus a JSON or form body of at most 16 KB. */
export const CARD_RETURN_BODY_LIMIT = 16 * 1024;
/** At most this many named values in one return; more is refused unread. */
export const CARD_RETURN_MAX_FIELDS = 64;
/** The words the return page can show — and nothing else (no amount, name, card or id). */
export const CARD_RETURN_PAGES = ['SUCCEEDED', 'PENDING', 'FAILED', 'UNKNOWN'] as const;
export type CardReturnPage = (typeof CARD_RETURN_PAGES)[number];
/** Where the "Back to the Swift app" link goes: no parameters, ever. */
export const CARD_APP_RETURN_LINK = 'swift://pay/card/return';

const IDEMPOTENCY_KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const STATE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const SIM_REF_SHAPE = /^sim_[0-9a-f]{24}$/;
const PAY_REF_SHAPE = /^ptz_[0-9a-f]{24}$/;

/** Over a limit is the contract's `429 RATE_LIMITED`, with the wait in seconds. */
const rateLimited = {
  errorResponseBuilder: (_request: FastifyRequest, context: { ttl: number }) =>
    new AppError(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute and try again.', { retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)) }),
};

/** [Sol · #1404, as the MMG doors] The public doors are limited per SOURCE:
 *  the proxy-resolved address (Fastify's trustProxy, never a raw
 *  X-Forwarded-For). Never the global key's per-user bucket, which a bearer
 *  token selects: one source rotating signed-in principals would multiply
 *  its allowance. */
const perSource = { keyGenerator: (request: FastifyRequest) => request.ip };

// ---------------------------------------------------------------------------
// The runtime: one service, one billing engine and one provider source,
// shared by every family. Tests decorate the app with their own (a simulator
// in its own Redis namespace); the server builds the default lazily, on the
// first request that needs it.
// ---------------------------------------------------------------------------

export const CARD_RAIL_RUNTIME_DECORATION = 'cardRailRuntime';

export interface CardRailRuntime {
  service: CardRailService;
  billing: BillingService;
  /** The same provider source the service uses. */
  rail: CardRailSource;
}

export function cardRailRuntimeOf(app: FastifyInstance): CardRailRuntime {
  if (app.hasDecorator(CARD_RAIL_RUNTIME_DECORATION)) {
    return (app as unknown as Record<string, CardRailRuntime>)[CARD_RAIL_RUNTIME_DECORATION]!;
  }
  const notifications = new NotificationService(app.prisma, app.io);
  let provider: CardRailProvider | undefined;
  const rail: CardRailSource = () => (provider ??= getCardRailProvider({ redis: app.redis }));
  const billing = new BillingService(app.prisma, notifications, getPaymentProvider(), undefined, rail);
  return { service: new CardRailService(app.prisma, notifications, billing, rail), billing, rail };
}

// ---------------------------------------------------------------------------
// Partner routes (sections 3-6)
// ---------------------------------------------------------------------------

export interface PartnerCardRouteOptions {
  /** The caller's OWN subscription after the family's own gate has run (an
   *  outsider throws 403 there; a partner still onboarding gets null): the
   *  same lookup the family's MMG checkout and GET /subscription use. */
  subscriptionFor: (request: FastifyRequest) => Promise<Subscription | null>;
}

/** What GET /subscription carries from the card rail. */
export interface CardSubscriptionFields {
  /** The CARD entry of payActions. */
  payAction: CardPayAction;
  /** The partner's most recent card session of the last 24 hours, as the
   *  session view (never its page address), or null. */
  latestCardSession: CardSessionView | null;
}

export interface PartnerCardRoutes {
  /** The CARD entry for this family's GET /subscription payActions. */
  payAction: (sub: Subscription, headers: Record<string, unknown>) => Promise<CardPayAction>;
  /** Everything GET /subscription carries from the card rail. Never fails. */
  subscriptionFields: (sub: Subscription, request: FastifyRequest) => Promise<CardSubscriptionFields>;
}

const LATEST_CARD_SESSION_MS = 24 * 3_600_000;

/**
 * The subscription payload's payActions with the card rail's own CARD entry in
 * place of the placeholder (fee-pay-actions.ts keeps CARD `off`), and
 * `latestCardSession`. Order and every other entry are unchanged.
 */
export function withCardPayAction<T extends { payActions: PayAction[] }>(payload: T, card: CardSubscriptionFields): T & { latestCardSession: CardSessionView | null } {
  return {
    ...payload,
    payActions: payload.payActions.map((a) => (a.id === 'CARD' ? card.payAction : a)),
    latestCardSession: card.latestCardSession,
  };
}

export interface CardSessionView {
  sessionId: string;
  purpose: 'ENROLL' | 'PAY_NOW';
  status: CardSessionStatus;
  expiresAt: string;
  amount?: number;
  currencyCode?: string;
  card?: PaymentInstrumentDto;
  /** PAY_NOW that SUCCEEDED: the paid week moved (`advanced`), or the money
   *  went to the balance because that week was already covered (`banked`). */
  settlement?: 'advanced' | 'banked';
  /** FAILED, EXPIRED or CANCELLED: why, in one plain category the screen can word. */
  failure?: CardSessionFailure;
  subscriptionStatus: string;
  testMode: boolean;
  testModeLabel?: string;
}

const sessionBody = z.object({
  purpose: z.enum(['ENROLL', 'PAY_NOW']),
  consentVersion: z.string().max(64).optional(),
}).strict();

const notFound = (code: string, message: string) => new AppError(404, code, message);

/** The service's 404s name the entity and id; the contract's name the code only. */
function mapNotFound<T>(promise: Promise<T>, code: string, message: string): Promise<T> {
  return promise.catch((err: unknown) => {
    if (err instanceof AppError && err.statusCode === 404) throw notFound(code, message);
    throw err;
  });
}

export function registerPartnerCardRoutes(app: FastifyInstance, options: PartnerCardRouteOptions): PartnerCardRoutes {
  let runtime: CardRailRuntime | null = null;
  const rt = () => (runtime ??= cardRailRuntimeOf(app));

  const ownSubscription = async (request: FastifyRequest): Promise<Subscription> => {
    // The family's gate first: an outsider is 403 before anything else is read.
    const sub = await options.subscriptionFor(request);
    // [REVIEW-PARTNER · DL-5] The store-review fiction has no money rail: no
    // card page, no card list, no card removal — before any key, body or id.
    if (request.tenantKind === 'REVIEW') throw new ReviewDemoMoneyRefusedError();
    if (!sub) throw notFound('SUBSCRIPTION_NOT_FOUND', 'There is no subscription for this account.');
    return sub;
  };

  /** Read by GET /subscription, the screen a partner pays on: it never fails
   *  that payload. Flag off: off, without building anything. Any error while
   *  deciding: off (fail closed), logged. */
  const payAction = async (sub: Subscription, headers: Record<string, unknown>): Promise<CardPayAction> => {
    if (!cardRailV2Enabled()) return CARD_OFF;
    try {
      const r = rt();
      return await cardPayAction(app.prisma, (id) => r.billing.quoteCardPayNow(id), sub, clientPlatform(headers), r.rail);
    } catch (err) {
      log().error({ err, subscriptionId: sub.id }, '[PT-2] the CARD pay action could not be decided; it is off');
      return CARD_OFF;
    }
  };

  /** GET …/subscription/cards — every card the subscription ever had, newest first, and the CARD pay action. */
  app.get('/subscription/cards', { preHandler: [app.authenticate] }, async (request) => {
    const sub = await ownSubscription(request);
    const cards = await mapNotFound(rt().service.listInstruments(request.user.userId, sub.id), 'SUBSCRIPTION_NOT_FOUND', 'There is no subscription for this account.');
    return { success: true, data: { cards, payAction: await payAction(sub, request.headers) } };
  });

  /** DELETE …/subscription/cards/:cardId — REVOKED at once; nothing falls back silently. */
  app.delete<{ Params: { cardId: string } }>('/subscription/cards/:cardId', { preHandler: [app.authenticate] }, async (request) => {
    const sub = await ownSubscription(request);
    // Taking the fee's card away is a money surface: confirm it is the account holder.
    await requireStepUp(app, request);
    if (!ID_SHAPE.test(request.params.cardId)) throw notFound('CARD_NOT_FOUND', 'There is no such card.');
    const removed = await mapNotFound(
      rt().service.removeInstrument({ userId: request.user.userId, instrumentId: request.params.cardId, subscriptionId: sub.id }),
      'CARD_NOT_FOUND', 'There is no such card.',
    );
    return { success: true, data: removed };
  });

  /** POST …/subscription/card-sessions — the server prices a Pay now; the body never carries an amount. */
  app.post('/subscription/card-sessions', {
    preHandler: [app.authenticate],
    config: { rateLimit: { ...CARD_SESSION_START_RATE, ...rateLimited } },
  }, async (request, reply) => {
    const sub = await ownSubscription(request);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_SHAPE.test(key)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key of 8–128 letters, digits, dashes or underscores, new for each tap.');
    }
    const parsed = sessionBody.safeParse(request.body ?? {});
    if (!parsed.success) throw new AppError(400, 'INVALID_CARD_SESSION', 'Send { purpose: "ENROLL" | "PAY_NOW" } and, to add a card, the consent version accepted on screen. Nothing else.');
    const { purpose, consentVersion } = parsed.data;

    const r = rt();
    const decision = await cardSessionsAllowed(app.prisma, sub, clientPlatform(request.headers), r.rail);
    if (!decision.allowed) {
      if (decision.reason === 'KILLED') throw new AppError(503, 'CARD_RAIL_DISABLED', 'Card payments are paused right now. Please use another way to pay.');
      throw new AppError(409, 'PAY_ACTION_OFF', 'Paying by card is not available for this account here.');
    }
    // Saving a card needs a provider that can charge it each week without the
    // partner present, and saving switched on (the consent wording awaits the
    // owner); otherwise only Pay now exists (`addCard: false`).
    if (purpose === 'ENROLL' && (!decision.provider.savesCards || !cardEnrollEnabled())) {
      throw new AppError(409, 'ADD_CARD_OFF', 'Saving a card is not available. You can pay this week by card instead.');
    }
    if (purpose === 'ENROLL' && consentVersion !== CARD_ON_FILE_CONSENT_VERSION) {
      throw new AppError(400, 'CARD_CONSENT_REQUIRED', 'Agree to weekly card charges before adding a card.');
    }
    const replay = await app.prisma.cardSession.findUnique({
      where: { subscriptionId_purpose_idempotencyKey: { subscriptionId: sub.id, purpose, idempotencyKey: key } },
      select: { id: true },
    });
    const session: CardSessionDto = await mapNotFound(
      r.service.startSession({
        userId: request.user.userId,
        subscriptionId: sub.id,
        purpose,
        idempotencyKey: key,
        ...(purpose === 'ENROLL' ? { consentVersion } : {}),
      }),
      'SUBSCRIPTION_NOT_FOUND', 'There is no subscription for this account.',
    );
    return reply.status(replay ? 200 : 201).send({ success: true, data: session });
  });

  /** GET …/subscription/card-sessions/:sessionId — one answer, 404, for an unknown session and for another partner's. */
  app.get<{ Params: { sessionId: string } }>('/subscription/card-sessions/:sessionId', { preHandler: [app.authenticate] }, async (request) => {
    const sub = await ownSubscription(request);
    if (!ID_SHAPE.test(request.params.sessionId)) throw notFound('CARD_SESSION_NOT_FOUND', 'There is no such card session.');
    const view = await cardSessionView(app.prisma, { sessionId: request.params.sessionId, subscription: sub, userId: request.user.userId });
    if (!view) throw notFound('CARD_SESSION_NOT_FOUND', 'There is no such card session.');
    return { success: true, data: view };
  });

  const subscriptionFields = async (sub: Subscription, request: FastifyRequest): Promise<CardSubscriptionFields> => {
    const action = await payAction(sub, request.headers);
    if (!cardRailV2Enabled() && !cardRailV2DrainEnabled()) return { payAction: action, latestCardSession: null };
    try {
      const latest = await app.prisma.cardSession.findFirst({
        where: { subscriptionId: sub.id, userId: request.user.userId, createdAt: { gte: new Date(Date.now() - LATEST_CARD_SESSION_MS) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      const view = latest ? await cardSessionView(app.prisma, { sessionId: latest.id, subscription: sub, userId: request.user.userId }) : null;
      return { payAction: action, latestCardSession: view };
    } catch (err) {
      log().error({ err, subscriptionId: sub.id }, '[PT-2] the latest card session could not be read; it is left out');
      return { payAction: action, latestCardSession: null };
    }
  };

  return { payAction, subscriptionFields };
}

export type CardSessionFailure = 'DECLINED' | 'NOT_AUTHENTICATED' | 'CARD_EXPIRED' | 'NOT_FINISHED' | 'PAGE_UNAVAILABLE';

/** The plain category of a closed session's failure code (never the provider's own words). */
export function cardSessionFailure(status: CardSessionStatus, failureCode: string | null): CardSessionFailure | undefined {
  if (status !== 'FAILED' && status !== 'EXPIRED' && status !== 'CANCELLED') return undefined;
  switch (failureCode) {
    case 'DECLINED': return 'DECLINED';
    case 'NOT_AUTHENTICATED': case 'EXPIRED_UNAUTHENTICATED': return 'NOT_AUTHENTICATED';
    case 'CARD_EXPIRED': return 'CARD_EXPIRED';
    case 'EXPIRED_UNUSED': case 'PROVIDER_UNKNOWN': return 'NOT_FINISHED';
    case 'PROVIDER_PAGE_UNAVAILABLE': return 'PAGE_UNAVAILABLE';
    default: return undefined;
  }
}

/** A session as its own partner may see it: no page address, no state, no provider reference. */
async function cardSessionView(
  prisma: PrismaClient,
  input: { sessionId: string; subscription: Pick<Subscription, 'id' | 'status'>; userId: string },
): Promise<CardSessionView | null> {
  const s = await prisma.cardSession.findFirst({
    where: { id: input.sessionId, subscriptionId: input.subscription.id, userId: input.userId },
    select: { id: true, purpose: true, status: true, expiresAt: true, amount: true, currencyCode: true, instrumentId: true, paymentId: true, provider: true, environment: true, failureCode: true },
  });
  if (!s) return null;
  const card = s.instrumentId
    ? await prisma.paymentInstrument.findUnique({ where: { id: s.instrumentId }, select: INSTRUMENT_DTO_SELECT })
    : null;
  // The same evidence settleHostedCardPayment reads: a bank event for this payment means it was banked.
  const settlement = s.purpose === 'PAY_NOW' && s.status === 'SUCCEEDED' && s.paymentId
    ? ((await prisma.billingEvent.findUnique({ where: { idempotencyKey: `bank:${s.paymentId}` }, select: { id: true } })) ? 'banked' as const : 'advanced' as const)
    : undefined;
  const testModeLabel = cardTestLabel(s);
  const testMode = testModeLabel !== undefined;
  return {
    sessionId: s.id,
    purpose: s.purpose,
    status: s.status,
    expiresAt: s.expiresAt.toISOString(),
    ...(s.purpose === 'PAY_NOW' ? { amount: Number(s.amount), currencyCode: s.currencyCode ?? undefined } : {}),
    ...(card ? { card } : {}),
    ...(settlement ? { settlement } : {}),
    ...(cardSessionFailure(s.status, s.failureCode) ? { failure: cardSessionFailure(s.status, s.failureCode)! } : {}),
    subscriptionStatus: input.subscription.status,
    testMode,
    ...(testModeLabel ? { testModeLabel } : {}),
  };
}

// ---------------------------------------------------------------------------
// The public doors (section 7): rate-limited, body-capped, never logged.
// ---------------------------------------------------------------------------

/** A form body's fields, bounded; a repeated name becomes an array (and is then refused). */
function formFields(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  let count = 0;
  for (const [key, value] of new URLSearchParams(text)) {
    if (count >= CARD_RETURN_MAX_FIELDS + 1) break;
    count += 1;
    const previous = out[key];
    out[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return out;
}

/** One string, or nothing: a value named twice is ambiguous. */
function single(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Everything a return carried besides Swift's own session and state, as
 * name -> string, for the provider to parse and digest. A nested JSON value
 * becomes its JSON text. Refused (null) when a name repeats, a list arrives,
 * a name is overlong or there are too many: an ambiguous return grants
 * nothing and is not even written down.
 */
export function returnParams(query: unknown, body: unknown): Record<string, string> | null {
  const out: Record<string, string> = Object.create(null);
  let count = 0;
  for (const source of [query, body]) {
    if (source === undefined || source === null || source === '') continue;
    if (typeof source !== 'object' || Array.isArray(source)) return null;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (key === 'session' || key === 'state') continue;
      count += 1;
      if (count > CARD_RETURN_MAX_FIELDS || key.length > 64 || key in out || Array.isArray(value)) return null;
      out[key] = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    }
  }
  return out;
}

function pageForStatus(status: CardSessionStatus): CardReturnPage {
  switch (status) {
    case 'SUCCEEDED': return 'SUCCEEDED';
    case 'FAILED': case 'CANCELLED': case 'EXPIRED': return 'FAILED';
    case 'OPEN': case 'UNKNOWN': case 'HELD': return 'PENDING';
    default: return 'UNKNOWN';
  }
}

// [CARD-PAGE] Each state wears the app's tone for it (cardSessionTone). The
// unknown state is headed "Weekly fee", as the MMG return page is.
const RETURN_WORDS: Record<CardReturnPage, { title: string; body: string; tone: CardPageTone }> = {
  SUCCEEDED: { title: 'Done', body: 'Go back to the Swift app to see it.', tone: 'success' },
  PENDING: { title: 'Checking with the bank', body: "We're checking with the bank. Don't pay again. You can close this page.", tone: 'waiting' },
  FAILED: { title: "This didn't go through", body: 'You can try again in the Swift app.', tone: 'error' },
  UNKNOWN: { title: 'Weekly fee', body: 'Open the Swift app to see your weekly fee.', tone: 'neutral' },
};

/** [CARD-PAGE] Every card page wears Swift's look (card-page-look.ts); its policy is set by the route, unchanged. */
const page = cardPageHtml;

/** [Review S3] "Continue on the web": the web's one neutral weekly-fee route,
 *  which picks the dashboard or the portal from the signed-in session (as the
 *  MMG return page does). The web's origin is APP_PUBLIC_URL. */
export function cardWebFeeUrl(env: Record<string, string | undefined> = process.env): string {
  let origin = 'https://swiftgy.com';
  try {
    const url = new URL(env['APP_PUBLIC_URL'] || origin);
    if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin;
  } catch {
    // an unreadable setting keeps the public web origin
  }
  return `${origin}/weekly-fee`;
}

/** A return state shows inside Swift's card page (the bank's frame comes back here), so it
 *  carries no header of its own: the kit's state pattern and the two ways back, as buttons. */
export function returnPageHtml(state: CardReturnPage): string {
  const words = RETURN_WORDS[state];
  return page(words.title, `<section class="state">${toneChip(words.tone, 32)}<h1>${escapeHtml(words.title)}</h1><p>${escapeHtml(words.body)}</p></section>`
    + `<div class="actions">${buttonLink(CARD_APP_RETURN_LINK, 'Back to the Swift app', 'primary')}`
    + `${buttonLink(cardWebFeeUrl(), 'Continue on the web', 'soft')}</div>`);
}

/** Never cached, never indexed, never sent onward as a referrer. */
function privatePage(reply: FastifyReply): FastifyReply {
  return reply
    .header('cache-control', 'no-store')
    .header('x-robots-tag', 'noindex')
    .header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8');
}

/**
 * One return. Swift's session and one-use state come back in the query (the
 * service built the return address); whatever the provider added comes in
 * the query or the body. The return is written down as an observation and,
 * only when it is the session's first valid one, prompts the server to ask
 * the provider — server to server. It never credits by itself.
 */
/** [Review S4] How long the return waits for the provider's server-side
 *  answer before it shows "checking with the bank". The confirmation goes on:
 *  its result is recorded when it comes, and the sweep asks again if it never does. */
export const CARD_RETURN_CONFIRM_WAIT_MS = 20_000;

async function confirmWithin(runtime: CardRailRuntime, sessionId: string, waitMs: number): Promise<CardReturnPage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const confirmed = runtime.service.confirm(sessionId).then((r) => pageForStatus(r.status));
  // A late failure is the sweep's to retry; it must not surface as an unhandled rejection.
  confirmed.catch((err: unknown) => log().error({ err }, '[PT-2] a card confirmation finished with an error after its return was answered'));
  const waited = new Promise<CardReturnPage>((resolve) => { timer = setTimeout(() => resolve('PENDING'), waitMs); });
  try {
    return await Promise.race([confirmed, waited]);
  } finally {
    clearTimeout(timer);
  }
}

async function processReturn(runtime: CardRailRuntime, prisma: PrismaClient, request: FastifyRequest, waitMs: number): Promise<CardReturnPage> {
  if (!cardRailV2Enabled() && !cardRailV2DrainEnabled()) return 'UNKNOWN';
  const query = (request.query ?? {}) as Record<string, unknown>;
  const sessionId = single(query['session']);
  const state = single(query['state']);
  if (!sessionId || !state || !ID_SHAPE.test(sessionId) || !STATE_SHAPE.test(state)) return 'UNKNOWN';
  const params = returnParams(query, request.body);
  if (!params) return 'UNKNOWN';
  // The browser arrives without the partner's Swift session (a cross-site
  // redirect from the provider). The session's own tenant scopes the work.
  const owner = await runAsSystem('card-return-session-tenant', () =>
    prisma.cardSession.findUnique({ where: { id: sessionId }, select: { tenantId: true } }));
  if (!owner) return 'UNKNOWN';
  return runWithTenant(owner.tenantId, async () => {
    const result = await runtime.service.handleReturn({ sessionId, state, params });
    if (result.accepted) return confirmWithin(runtime, sessionId, waitMs);
    // Past the state check (a reload, a late or repeated return): the
    // session's own status. Anything else learns nothing.
    if (result.verdict === 'REJECTED_REPLAY' || result.verdict === 'REJECTED_CLOSED' || result.verdict === 'REJECTED_EXPIRED') {
      const now = await prisma.cardSession.findUnique({ where: { id: sessionId }, select: { status: true } });
      return now ? pageForStatus(now.status) : 'UNKNOWN';
    }
    return 'UNKNOWN';
  });
}

/** The simulator, when — and only when — it is this server's provider, off production. */
function simulatorOf(runtime: CardRailRuntime): SimulatorCardRailProvider | null {
  if (isProduction() || (!cardRailV2Enabled() && !cardRailV2DrainEnabled())) return null;
  try {
    const provider = runtime.rail();
    return provider instanceof SimulatorCardRailProvider ? provider : null;
  } catch {
    return null;
  }
}

/** [PT-4] The real provider, when it is this server's provider (and v2 is on or draining). */
function powerTranzOf(runtime: CardRailRuntime): PowerTranzCardRailProvider | null {
  if (!cardRailV2Enabled() && !cardRailV2DrainEnabled()) return null;
  try {
    const provider = runtime.rail();
    return provider instanceof PowerTranzCardRailProvider ? provider : null;
  } catch {
    return null;
  }
}

/**
 * [PT-4] Swift's own page around the bank's card form (guide v2.7 sec. 2.2
 * 1.5, Appendix 2): the provider's RedirectData is bound into an iframe, where
 * the card is typed and the bank's 3-D Secure check runs. Swift's page only
 * frames it: its words name "your bank" and the card, never the provider.
 */
export const CARD_FRAME_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation-by-user-activation';

function hostedCardPageHtml(facts: PowerTranzHostedPage): string {
  const price = formatAmount(fromMinor(facts.amountMinor, facts.currencyCode));
  const test = facts.sandbox ? testBanner(CARD_SANDBOX_TEST_LABEL) : '';
  const head = `${SWIFT_PAGE_HEADER}${test}<h1>${escapeHtml(`Pay ${price} by card`)}</h1>`;
  if (facts.expired || facts.finished) {
    return page('Swift card payment', `${head}<div class="panel">${toneChip('neutral')}<p>This card page has ended. Open the Swift app to see your weekly fee, or start again there.</p></div>`
      + `<div class="actions">${buttonLink(CARD_APP_RETURN_LINK, 'Back to the Swift app', 'primary')}</div>`);
  }
  return page('Swift card payment', `${head}`
    + `<p class="lede">${LOCK_ICON}<span>Type your card on your bank's secure form below. Swift never sees your card number or security code.</span></p>`
    // [Review S3] Sandboxed: scripts and forms run (the self-posting form, the
    // bank's 3-D Secure pages), same-origin is kept so the bank's pages keep
    // their own cookies, popups for a bank that opens one; the frame can move
    // this page only when the partner taps (the return page's links).
    + `<div class="frame"><iframe class="card" title="Your bank's secure card form" sandbox="${CARD_FRAME_SANDBOX}" srcdoc="${escapeHtml(facts.redirectData)}" allow="payment"></iframe></div>`
    // [REVIEW-F #2140 S4-1] Under the frame, which may already say "Done": never "Cancel" (it could read as undoing a payment).
    + `<div class="actions">${buttonLink(CARD_APP_RETURN_LINK, 'Go back to the Swift app', 'soft')}</div>`);
}

/** The card provider's own origins (its API is pinned to ptranz.com, guide sec. 2.3). */
const CARD_PROVIDER_ORIGINS = 'https://*.ptranz.com';

/**
 * [PT-4 · review S3] The page's own policy. The bank's form runs inside the
 * iframe (a srcdoc frame inherits this policy): only the provider's scripts
 * may run there and its form may post only to the provider; the frame may
 * then navigate to the provider's hosted page, the card's bank (3-D Secure
 * challenge pages live on each bank's own host) and back to Swift; nothing on
 * this page may call Swift's API or be framed by another site.
 */
export const HOSTED_CARD_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CARD_PROVIDER_ORIGINS}`,
  `style-src 'unsafe-inline' ${CARD_PROVIDER_ORIGINS}`,
  'img-src data: https:',
  `font-src data: ${CARD_PROVIDER_ORIGINS}`,
  "frame-src 'self' https:",
  `form-action ${CARD_PROVIDER_ORIGINS}`,
  "connect-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * [CARD embed] Swift's OWN web origin (APP_PUBLIC_URL): the website shows the card page
 * inside its weekly-fee page, so it is the one other site that may frame these pages.
 * https only; unset, plain http, credentials or unreadable: none.
 */
export function cardWebFrameOrigin(env: Record<string, string | undefined> = process.env): string | null {
  try {
    const url = new URL(env['APP_PUBLIC_URL'] ?? '');
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/** The hosted card page's policy: HOSTED_CARD_PAGE_CSP, framed only by Swift's own web (else by nothing). */
export function hostedCardPageCsp(web: string | null = cardWebFrameOrigin()): string {
  return HOSTED_CARD_PAGE_CSP.replace("frame-ancestors 'none'", `frame-ancestors ${web ?? "'none'"}`);
}

/**
 * [CARD embed] The return page's and the simulator's own policy: plain words and links,
 * no script, nothing fetched. The return page may be framed by this API (Swift's card page
 * frames the bank's form, which comes back here), by the card provider's frames, and by
 * Swift's own web; the simulator by this API and Swift's own web. Never '*'.
 */
// (Not called kind: the phone's notification census reads every kind literal in the API.)
export function cardTextPageCsp(page: 'return' | 'simulator', web: string | null = cardWebFrameOrigin()): string {
  const ancestors = ["'self'", ...(page === 'return' ? [CARD_PROVIDER_ORIGINS] : []), ...(web ? [web] : [])];
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `form-action ${page === 'simulator' ? "'self'" : "'none'"}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${ancestors.join(' ')}`,
  ].join('; ');
}

/** The policy is the authority on framing: X-Frame-Options agrees with it (DENY / SAMEORIGIN) or gives way. */
function framing(reply: FastifyReply, csp: string): FastifyReply {
  const ancestors = /frame-ancestors ([^;]+)/.exec(csp)?.[1]?.trim();
  reply.header('content-security-policy', csp);
  if (ancestors === "'none'") reply.header('x-frame-options', 'DENY');
  else if (ancestors === "'self'") reply.header('x-frame-options', 'SAMEORIGIN');
  else reply.removeHeader('x-frame-options');
  return reply;
}

function simulatorPageHtml(ref: string, facts: NonNullable<Awaited<ReturnType<SimulatorCardRailProvider['pageFor']>>>): string {
  const what = facts.purpose === 'ENROLL'
    ? 'Add a card'
    : `Pay ${formatAmount(fromMinor(facts.amountMinor ?? 0, facts.currencyCode ?? ''), { code: true })}`;
  const head = `${SWIFT_PAGE_HEADER}${testBanner(SIMULATOR_PAGE.testModeLabel)}<h1>${escapeHtml(SIMULATOR_PAGE.title)}</h1><p>${escapeHtml(what)}</p>`;
  if (facts.expired) return page(SIMULATOR_PAGE.title, `${head}<p>This test page has expired. Start again in the Swift app.</p>`);
  // Buttons only: a <button name value> submits its scenario without any input field [C10].
  const buttons = SIMULATOR_PAGE.buttons.map((b) =>
    `<button type="submit" name="scenario" value="${b.scenario}">${escapeHtml(b.label)}</button><p>${escapeHtml(b.explains)}</p>`).join('');
  return page(SIMULATOR_PAGE.title, `${head}<form method="post" action="/api/v1/billing/card/simulator/${escapeHtml(ref)}">${buttons}</form>`);
}

export async function cardRailPublicRoutes(app: FastifyInstance, opts: { confirmWaitMs?: number } = {}): Promise<void> {
  const confirmWaitMs = opts.confirmWaitMs ?? CARD_RETURN_CONFIRM_WAIT_MS;
  // A provider may return a form post; the server has no form parser
  // elsewhere, so this one is scoped to these routes.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: CARD_RETURN_BODY_LIMIT }, (_request, body, done) => {
    try {
      done(null, formFields(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // [PT-4] The bank's frame posts its result "as Json" (guide v2.7 Appendix 2);
  // a form can only send it as text. A text body is read as JSON or not at all.
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: CARD_RETURN_BODY_LIMIT }, (_request, body, done) => {
    try {
      const value: unknown = JSON.parse(body as string);
      done(null, value && typeof value === 'object' && !Array.isArray(value) ? value : body);
    } catch {
      done(null, body);
    }
  });

  let runtime: CardRailRuntime | null = null;
  const rt = () => (runtime ??= cardRailRuntimeOf(app));

  // The return address carries the one-use state in its query: these routes
  // never write a request line to the log (logLevel silent), and the handler
  // never throws with the URL.
  const returnHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    let state: CardReturnPage = 'UNKNOWN';
    try {
      state = await processReturn(rt(), app.prisma, request, confirmWaitMs);
    } catch (err) {
      log().error({ err }, '[PT-2] a card return could not be finished; the sweep asks the provider again');
      state = 'PENDING';
    }
    return framing(privatePage(reply), cardTextPageCsp('return')).send(returnPageHtml(state));
  };
  const returnOptions = {
    logLevel: 'silent' as const,
    bodyLimit: CARD_RETURN_BODY_LIMIT,
    config: { rateLimit: { ...CARD_RETURN_RATE, ...perSource, ...rateLimited } },
  };
  app.get('/return', returnOptions, returnHandler);
  app.post('/return', returnOptions, returnHandler);

  const simulatorOptions = {
    logLevel: 'silent' as const,
    bodyLimit: 1024,
    config: { rateLimit: { ...CARD_SIMULATOR_RATE, ...perSource, ...rateLimited } },
  };
  const simulatorMissing = (reply: FastifyReply, status = 404, words = 'There is no such test page.') =>
    framing(privatePage(reply), cardTextPageCsp('simulator')).status(status).send(page(SIMULATOR_PAGE.title, `${SWIFT_PAGE_HEADER}<h1>${escapeHtml(SIMULATOR_PAGE.title)}</h1><p>${escapeHtml(words)}</p>`));

  /** [PT-4] Swift's page around the bank's card form. Never logged, never cached; its own strict policy. */
  app.get<{ Params: { ref: string } }>('/pay/:ref', simulatorOptions, async (request, reply) => {
    const provider = powerTranzOf(rt());
    const facts = provider && PAY_REF_SHAPE.test(request.params.ref) ? await provider.hostedPageFor(request.params.ref) : null;
    if (!facts) {
      return framing(privatePage(reply), hostedCardPageCsp()).status(404).send(page('Swift card payment', `${SWIFT_PAGE_HEADER}<h1>There is no such card page</h1>`
        + `<p>Open the Swift app to see your weekly fee.</p><div class="actions">${buttonLink(CARD_APP_RETURN_LINK, 'Back to the Swift app', 'primary')}</div>`));
    }
    return framing(privatePage(reply), hostedCardPageCsp()).send(hostedCardPageHtml(facts));
  });

  /** The simulator's page: four buttons, no inputs, a TEST PAGE label. */
  app.get<{ Params: { ref: string } }>('/simulator/:ref', simulatorOptions, async (request, reply) => {
    const sim = simulatorOf(rt());
    if (!sim || !SIM_REF_SHAPE.test(request.params.ref)) return simulatorMissing(reply);
    const facts = await sim.pageFor(request.params.ref);
    if (!facts) return simulatorMissing(reply);
    return framing(privatePage(reply), cardTextPageCsp('simulator')).send(simulatorPageHtml(request.params.ref, facts));
  });

  /** A button: the simulator records what the "bank" did, once, and the browser goes back to the return address. */
  app.post<{ Params: { ref: string } }>('/simulator/:ref', simulatorOptions, async (request, reply) => {
    const sim = simulatorOf(rt());
    if (!sim || !SIM_REF_SHAPE.test(request.params.ref)) return simulatorMissing(reply);
    const body = request.body as Record<string, unknown> | undefined;
    try {
      const { redirectUrl } = await sim.choose(request.params.ref, single(body?.['scenario']));
      return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(redirectUrl, 303);
    } catch (err) {
      if (!(err instanceof SimulatorRefusal)) throw err;
      switch (err.code) {
        case 'SESSION_EXPIRED': return simulatorMissing(reply, 410, 'This test page has expired. Start again in the Swift app.');
        case 'ALREADY_CHOSEN': return simulatorMissing(reply, 409, 'A different button was already pressed on this test page.');
        case 'UNKNOWN_SCENARIO': return simulatorMissing(reply, 400, 'That is not one of the four buttons.');
        default: return simulatorMissing(reply);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Admin read views (section 8). The routes are declared in admin.routes.ts
// (its census reads that file), so its admin gate, capability decision and
// tenant binding run first; these are their queries. Nothing here
// returns a vault token, the state or its hash, a page address, a provider
// session reference or anything else that could move money. [PT-4] The
// provider's transaction reference is shown to finance: it names a payment
// to look up in the provider's portal and cannot move money by itself.
// ---------------------------------------------------------------------------

const ADMIN_SESSION_SELECT = {
  id: true, subscriptionId: true, userId: true, purpose: true, status: true,
  provider: true, environment: true, providerAccount: true,
  amount: true, currencyCode: true, periodStart: true,
  expiresAt: true, returnedAt: true, confirmedAt: true, lastCheckedAt: true,
  consentVersion: true, consentAt: true, failureCode: true,
  instrumentId: true, paymentId: true, createdAt: true,
  // [Review S2-2] What finance needs to look a held payment up and resolve it.
  providerTransactionRef: true, providerVoidState: true, providerRefundState: true, bookClaimedAt: true, resolution: true, resolvedBy: true, resolvedAt: true,
} as const;

const ADMIN_CARD_SELECT = {
  id: true, subscriptionId: true, userId: true, brand: true, last4: true, expMonth: true, expYear: true, status: true,
  provider: true, environment: true, providerAccount: true, consentVersion: true, consentAt: true,
  createdAt: true, replacedAt: true, replacedById: true, revokedAt: true, revokedBy: true, expiredAt: true,
} as const;

const adminListQuery = z.object({
  status: z.enum(['OPEN', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'HELD']).optional(),
  purpose: z.enum(['ENROLL', 'PAY_NOW']).optional(),
  subscriptionId: z.string().regex(ID_SHAPE).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const boundTenant = (): string => {
  const tenantId = getTenantId();
  if (!tenantId) throw new AppError(403, 'FORBIDDEN', 'Tenant context required');
  return tenantId;
};

const withAmount = <T extends { amount: unknown }>(row: T) => ({ ...row, amount: row.amount === null ? null : Number(row.amount) });

/** GET /billing/card-sessions — newest first; `status=HELD` is the review queue. */
export async function adminCardSessions(prisma: PrismaClient, query: unknown) {
  const q = adminListQuery.parse(query ?? {});
  const rows = await prisma.cardSession.findMany({
    where: { tenantId: boundTenant(), ...(q.status ? { status: q.status } : {}), ...(q.purpose ? { purpose: q.purpose } : {}), ...(q.subscriptionId ? { subscriptionId: q.subscriptionId } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: q.limit,
    select: ADMIN_SESSION_SELECT,
  });
  return { sessions: rows.map(withAmount) };
}

/** GET /billing/card-sessions/:id — one session and its evidence (hashes, never payloads). */
export async function adminCardSession(prisma: PrismaClient, id: string) {
  if (!ID_SHAPE.test(id)) throw notFound('CARD_SESSION_NOT_FOUND', 'There is no such card session.');
  const session = await prisma.cardSession.findFirst({ where: { id, tenantId: boundTenant() }, select: ADMIN_SESSION_SELECT });
  if (!session) throw notFound('CARD_SESSION_NOT_FOUND', 'There is no such card session.');
  const observations = await prisma.cardObservation.findMany({
    where: { sessionId: session.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { source: true, parsedStatus: true, verdict: true, rawSha256: true, createdAt: true },
  });
  return { session: withAmount(session), observations };
}

const resolveBody = z.object({
  action: z.enum(CARD_RESOLVE_ACTIONS),
  providerReference: z.string().trim().min(1).max(64),
  amount: z.number().positive().max(99_999_999),
  /** The stated reason may come in the body as well as the header (ADM-006). */
  reason: z.string().trim().max(2000).optional(),
}).strict();

/**
 * [Review S2-2] POST /billing/card-sessions/:id/resolve — finance decides a
 * HELD card payment after checking the provider's portal: book it (exactly
 * this week's price), refund it (one refund, durably claimed), record a
 * refund made in the portal, or record that nothing was taken. Declared C4 in
 * admin-authority.ts: two people. The session must be in the admin's tenant.
 */
export async function adminResolveCardSession(app: FastifyInstance, id: string, body: unknown, adminUserId: string, onAudit?: OnAudit) {
  // [Opus S4-f] Gated like every other card route: with the card rail off and
  // not draining, nothing acts on a card session. Draining (CARD_RAIL_V2_DRAIN)
  // is how what was in flight, held payments included, gets finished.
  if (!cardRailV2Enabled() && !cardRailV2DrainEnabled()) throw new AppError(404, 'CARD_RAIL_UNAVAILABLE', 'Card payments are not available.');
  if (!ID_SHAPE.test(id)) throw notFound('CARD_SESSION_NOT_FOUND', 'There is no such card session.');
  const parsed = resolveBody.safeParse(body ?? {});
  if (!parsed.success) throw new AppError(400, 'INVALID_RESOLUTION', `Send { action: ${CARD_RESOLVE_ACTIONS.join(' | ')}, providerReference, amount }.`);
  const tenantId = boundTenant();
  const owned = await app.prisma.cardSession.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!owned) throw notFound('CARD_SESSION_NOT_FOUND', 'There is no such card session.');
  const { action, providerReference, amount } = parsed.data;
  return mapNotFound(
    cardRailRuntimeOf(app).service.resolveHeld({ sessionId: id, tenantId, action, providerReference, amount, adminUserId, ...(onAudit ? { onAudit } : {}) }),
    'CARD_SESSION_NOT_FOUND', 'There is no such card session.',
  );
}

/** GET /billing/subscriptions/:subscriptionId/cards — the bound setup, consent and how each card left service. */
export async function adminSubscriptionCards(prisma: PrismaClient, subscriptionId: string) {
  if (!ID_SHAPE.test(subscriptionId)) throw notFound('SUBSCRIPTION_NOT_FOUND', 'There is no such subscription.');
  const cards = await prisma.paymentInstrument.findMany({
    where: { subscriptionId, tenantId: boundTenant() },
    orderBy: { createdAt: 'desc' },
    select: ADMIN_CARD_SELECT,
  });
  return { cards };
}
