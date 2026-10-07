import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CardSessionStatus, PrismaClient, Subscription } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { isProduction } from '../../utils/runtime-mode';
import { cardRailV2DrainEnabled, cardRailV2Enabled } from '../../utils/card-rail';
import { formatAmount, fromMinor } from '../../utils/currency-amount';
import { getTenantId, runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { requireStepUp } from '../auth/step-up';
import { NotificationService } from '../notification/notification.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { getCardRailProvider } from '../../providers/card/card-rail-factory';
import type { CardRailProvider, CardRailSource } from '../../providers/card/card-provider';
import { SIMULATOR_PAGE, SimulatorCardRailProvider, SimulatorRefusal } from '../../providers/card/simulator-provider';
import { BillingService } from './billing.service';
import { CARD_ON_FILE_CONSENT_VERSION, CardRailService, INSTRUMENT_DTO_SELECT, type CardSessionDto, type PaymentInstrumentDto } from './card-rail.service';
import { cardPayAction, cardSessionsAllowed, clientPlatform, type CardPayAction } from './card-pay-action';

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

/** Over a limit is the contract's `429 RATE_LIMITED`, with the wait in seconds. */
const rateLimited = {
  errorResponseBuilder: (_request: FastifyRequest, context: { ttl: number }) =>
    new AppError(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute and try again.', { retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)) }),
};

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
   *  outsider throws 403 there; a partner still onboarding gets null). */
  subscriptionFor: (request: FastifyRequest) => Promise<Subscription | null>;
}

export interface CardSessionView {
  sessionId: string;
  purpose: 'ENROLL' | 'PAY_NOW';
  status: CardSessionStatus;
  expiresAt: string;
  amount?: number;
  currencyCode?: string;
  card?: PaymentInstrumentDto;
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

export function registerPartnerCardRoutes(app: FastifyInstance, options: PartnerCardRouteOptions): void {
  let runtime: CardRailRuntime | null = null;
  const rt = () => (runtime ??= cardRailRuntimeOf(app));

  const ownSubscription = async (request: FastifyRequest): Promise<Subscription> => {
    // The family's gate first: an outsider is 403 before anything else is read.
    const sub = await options.subscriptionFor(request);
    if (!sub) throw notFound('SUBSCRIPTION_NOT_FOUND', 'There is no subscription for this account.');
    return sub;
  };

  /** GET …/subscription/cards — every card the subscription ever had, newest first, and the CARD pay action. */
  app.get('/subscription/cards', { preHandler: [app.authenticate] }, async (request) => {
    const sub = await ownSubscription(request);
    const r = rt();
    const cards = await mapNotFound(r.service.listInstruments(request.user.userId, sub.id), 'SUBSCRIPTION_NOT_FOUND', 'There is no subscription for this account.');
    const payAction: CardPayAction = await cardPayAction(
      app.prisma, (id) => r.billing.quoteCardPayNow(id), sub, clientPlatform(request.headers), r.rail,
    );
    return { success: true, data: { cards, payAction } };
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
}

/** A session as its own partner may see it: no page address, no state, no provider reference. */
async function cardSessionView(
  prisma: PrismaClient,
  input: { sessionId: string; subscription: Pick<Subscription, 'id' | 'status'>; userId: string },
): Promise<CardSessionView | null> {
  const s = await prisma.cardSession.findFirst({
    where: { id: input.sessionId, subscriptionId: input.subscription.id, userId: input.userId },
    select: { id: true, purpose: true, status: true, expiresAt: true, amount: true, currencyCode: true, instrumentId: true, provider: true },
  });
  if (!s) return null;
  const card = s.instrumentId
    ? await prisma.paymentInstrument.findUnique({ where: { id: s.instrumentId }, select: INSTRUMENT_DTO_SELECT })
    : null;
  const testMode = s.provider === 'simulator';
  return {
    sessionId: s.id,
    purpose: s.purpose,
    status: s.status,
    expiresAt: s.expiresAt.toISOString(),
    ...(s.purpose === 'PAY_NOW' ? { amount: Number(s.amount), currencyCode: s.currencyCode ?? undefined } : {}),
    ...(card ? { card } : {}),
    subscriptionStatus: input.subscription.status,
    testMode,
    ...(testMode ? { testModeLabel: SIMULATOR_PAGE.testModeLabel } : {}),
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

const RETURN_WORDS: Record<CardReturnPage, { title: string; body: string }> = {
  SUCCEEDED: { title: 'Done', body: 'Go back to the Swift app to see it.' },
  PENDING: { title: 'Checking with the bank', body: "We're checking with the bank. Don't pay again. You can close this page." },
  FAILED: { title: "This didn't go through", body: 'You can try again in the Swift app.' },
  UNKNOWN: { title: 'Swift', body: 'Open the Swift app to see your weekly fee.' },
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>`
    + `<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px;background:#fff;color:#111;max-width:480px}`
    + `h1{font-size:22px}p{font-size:16px;line-height:1.5}.test{background:#fff3cd;border:2px solid #b8860b;padding:12px;font-weight:700}`
    + `button{display:block;width:100%;margin:12px 0;padding:14px;font-size:16px;border-radius:10px;border:1px solid #111;background:#f6f6f6}`
    + `a{color:#111;font-weight:600}</style></head><body>${inner}</body></html>`;
}

export function returnPageHtml(state: CardReturnPage): string {
  const words = RETURN_WORDS[state];
  return page(words.title, `<h1>${escapeHtml(words.title)}</h1><p>${escapeHtml(words.body)}</p>`
    + `<p><a href="${CARD_APP_RETURN_LINK}" target="_top">Back to the Swift app</a></p>`);
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
async function processReturn(runtime: CardRailRuntime, prisma: PrismaClient, request: FastifyRequest): Promise<CardReturnPage> {
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
    if (result.accepted) return pageForStatus((await runtime.service.confirm(sessionId)).status);
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

function simulatorPageHtml(ref: string, facts: NonNullable<Awaited<ReturnType<SimulatorCardRailProvider['pageFor']>>>): string {
  const what = facts.purpose === 'ENROLL'
    ? 'Add a card'
    : `Pay ${formatAmount(fromMinor(facts.amountMinor ?? 0, facts.currencyCode ?? ''), { code: true })}`;
  const head = `<p class="test">${escapeHtml(SIMULATOR_PAGE.testModeLabel)}</p><h1>${escapeHtml(SIMULATOR_PAGE.title)}</h1><p>${escapeHtml(what)}</p>`;
  if (facts.expired) return page(SIMULATOR_PAGE.title, `${head}<p>This test page has expired. Start again in the Swift app.</p>`);
  // Buttons only: a <button name value> submits its scenario without any input field [C10].
  const buttons = SIMULATOR_PAGE.buttons.map((b) =>
    `<button type="submit" name="scenario" value="${b.scenario}">${escapeHtml(b.label)}</button><p>${escapeHtml(b.explains)}</p>`).join('');
  return page(SIMULATOR_PAGE.title, `${head}<form method="post" action="/api/v1/billing/card/simulator/${escapeHtml(ref)}">${buttons}</form>`);
}

export async function cardRailPublicRoutes(app: FastifyInstance): Promise<void> {
  // A provider may return a form post; the server has no form parser
  // elsewhere, so this one is scoped to these routes.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: CARD_RETURN_BODY_LIMIT }, (_request, body, done) => {
    try {
      done(null, formFields(body as string));
    } catch (err) {
      done(err as Error, undefined);
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
      state = await processReturn(rt(), app.prisma, request);
    } catch (err) {
      log().error({ err }, '[PT-2] a card return could not be finished; the sweep asks the provider again');
      state = 'PENDING';
    }
    return privatePage(reply).send(returnPageHtml(state));
  };
  const returnOptions = {
    logLevel: 'silent' as const,
    bodyLimit: CARD_RETURN_BODY_LIMIT,
    config: { rateLimit: { ...CARD_RETURN_RATE, ...rateLimited } },
  };
  app.get('/return', returnOptions, returnHandler);
  app.post('/return', returnOptions, returnHandler);

  const simulatorOptions = {
    logLevel: 'silent' as const,
    bodyLimit: 1024,
    config: { rateLimit: { ...CARD_SIMULATOR_RATE, ...rateLimited } },
  };
  const simulatorMissing = (reply: FastifyReply, status = 404, words = 'There is no such test page.') =>
    privatePage(reply).status(status).send(page(SIMULATOR_PAGE.title, `<h1>${escapeHtml(SIMULATOR_PAGE.title)}</h1><p>${escapeHtml(words)}</p>`));

  /** The simulator's page: four buttons, no inputs, a TEST PAGE label. */
  app.get<{ Params: { ref: string } }>('/simulator/:ref', simulatorOptions, async (request, reply) => {
    const sim = simulatorOf(rt());
    if (!sim || !SIM_REF_SHAPE.test(request.params.ref)) return simulatorMissing(reply);
    const facts = await sim.pageFor(request.params.ref);
    if (!facts) return simulatorMissing(reply);
    return privatePage(reply).send(simulatorPageHtml(request.params.ref, facts));
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
// session reference or anything else that could move money.
// ---------------------------------------------------------------------------

const ADMIN_SESSION_SELECT = {
  id: true, subscriptionId: true, userId: true, purpose: true, status: true,
  provider: true, environment: true, providerAccount: true,
  amount: true, currencyCode: true, periodStart: true,
  expiresAt: true, returnedAt: true, confirmedAt: true, lastCheckedAt: true,
  consentVersion: true, consentAt: true, failureCode: true,
  instrumentId: true, paymentId: true, createdAt: true,
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
