import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SosService } from './sos.service';
import { GuardianService } from './guardian.service';
import { LivenessService } from './liveness.service';
import { IncidentService, DECISION_CODES } from './incident.service';
import { EvidenceService } from './evidence.service';
import { EmergencyContactService } from './emergency-contact.service';
import { getChannels } from '../../providers/notifications/channels';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import { NotFoundError, ForbiddenError, AppError } from '../../utils/errors';
import { runWithoutTenant } from '../../plugins/tenant-context';

// SOS endpoints (safety spec §4.5). The engine (state machine, grace, fan-out)
// lives in SosService; these are thin, authed wrappers. Owner actions require
// the caller to be the alert's actor; ack/resolve are ops-only.
const createSchema = z.object({
  orderId: z.string().min(1).optional(),
  // [B3] The service-job context (hired-professional visit). Mutually
  // exclusive with orderId — an emergency happens in exactly one place.
  serviceJobId: z.string().min(1).optional(),
  source: z.enum(['BUTTON', 'OPS_MANUAL']).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100_000).optional(),
  addressText: z.string().max(500).optional(),
  clientCreatedAt: z.string().datetime().optional(),
  clientIdempotencyKey: z.string().min(8).max(128).optional(),
});

const resolveSchema = z.object({
  resolutionCode: z.enum(['SAFE_CONFIRMED', 'POLICE_INVOLVED', 'MEDICAL', 'FALSE_ALARM', 'ABUSE', 'UNREACHABLE_CLOSED']),
  notes: z.string().max(2000).optional(),
});

// War-room feed (§4.4). `open` = the alerts ops must act on right now.
const listAlertsQuery = z.object({
  status: z.enum(['open', 'active', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const OPEN_STATUSES = ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED'] as const;

export async function safetyRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const sos = new SosService(app.prisma, app.io);
  const isOps = (role: string) => role === 'ADMIN' || role === 'SUPER_ADMIN';
  // [TA-S0-004] A platform responder (SUPER_ADMIN) is paged for EVERY tenant's
  // alert and for the null-tenant ones — the page deliberately escapes tenant
  // scope. Until now the read, the acknowledgement and the resolution did not:
  // authentication binds every request, SUPER_ADMIN included, to the caller's
  // own tenant, so the responder who was just paged opened the alert and got an
  // empty board or a 404, and could neither acknowledge nor resolve it. The
  // privilege that pages them is the privilege that lets them act: the ops
  // handlers run unscoped for a platform responder. A tenant ADMIN stays inside
  // their tenant — scoping is the rule, this is the one sanctioned exception.
  const isPlatformResponder = (role: string) => role === 'SUPER_ADMIN';
  const asResponder = <T>(role: string, fn: () => Promise<T>): Promise<T> => (isPlatformResponder(role) ? runWithoutTenant(fn) : fn());

  async function ownedAlert(id: string, userId: string) {
    const a = await app.prisma.sosAlert.findUnique({ where: { id } });
    if (!a) throw new NotFoundError('SosAlert', id);
    if (a.actorUserId !== userId) throw new ForbiddenError('This is not your alert.');
    return a;
  }

  /**
   * [F-026-13 / LHC-1 K2] A limiter must NEVER stand between a person and
   * help. These routes were covered only by the global 200/min ceiling with
   * no exemption, so a burst — a panicking person tapping repeatedly, or a
   * session whose budget was already spent on ordinary traffic — could be
   * answered with 429 at the exact moment it mattered. Authentication still
   * applies; only the throttle is lifted, and the trigger is idempotent on
   * clientIdempotencyKey so repeats collapse into one alert rather than
   * flooding ops.
   */
  const lifeSafety = { preHandler: [app.authenticate], config: { rateLimit: false as const } };

  /** POST /sos — raise an alert (grace window opens unless ops-raised).
   *
   *  [REPORT-035 F-035-03/04 · INVARIANT] A life-safety trigger is NEVER
   *  refused over its context claim. The old shape 400'd on both-ids and
   *  404'd on a stale/foreign context id — erasing a live cry for help
   *  because its metadata was wrong. The rule now: an invalid context claim
   *  DEGRADES the alert to context-free (the alert still exists, ops still
   *  pages, the person's own live location still rides) and logs loudly.
   *  Authorization is unchanged — context and counterparty only ATTACH when
   *  the caller is genuinely a participant — and the existence oracle is
   *  closed harder than before: every request succeeds, so a prober learns
   *  nothing from the response shape. (Registered as a standing invariant
   *  for founder ratification.) */
  app.post('/sos', lifeSafety, async (request) => {
    const body = createSchema.parse(request.body ?? {});

    let orderId = body.orderId ?? null;
    let serviceJobId = body.serviceJobId ?? null;
    if (orderId && serviceJobId) {
      // An emergency happens in one place — but a malformed claim must not
      // erase the alert. Drop BOTH contexts rather than guess which is real.
      request.log.warn({ userId: request.user.userId, orderId, serviceJobId }, '[F-035-03] SOS carried both contexts — degrading to a context-free alert');
      orderId = null;
      serviceJobId = null;
    }

    let counterpartyUserId: string | null = null;
    let orderType: import('@prisma/client').OrderType | null = null;
    if (orderId) {
      // Only a participant on THIS order gets the order ATTACHED (§4.5 authz).
      const order = await app.prisma.order.findFirst({
        where: {
          id: orderId,
          OR: [{ customerId: request.user.userId }, { driver: { userId: request.user.userId } }, { rider: { userId: request.user.userId } }],
        },
        select: { id: true, orderType: true, customerId: true, driver: { select: { userId: true } }, rider: { select: { userId: true } } },
      });
      if (!order) {
        request.log.warn({ userId: request.user.userId, orderId }, '[F-035-04] SOS order context did not resolve for this caller — degrading to a context-free alert');
        orderId = null;
      } else {
        orderType = order.orderType;
        counterpartyUserId = [order.customerId, order.driver?.userId, order.rider?.userId].find((u) => u && u !== request.user.userId) ?? null;
      }
    }

    // [B3] A ServiceJob is not an order, so the participant rule gets its own
    // clause: only the CUSTOMER on the job or the PROVIDER doing it gets the
    // job attached.
    if (serviceJobId) {
      // [TA-S1-006] Participation is by USER ID; the job's tenant is its own
      // durable column and decides the routing downstream. Read outside the
      // request's tenant binding so a participant whose account has drifted
      // from the job's tenant still gets the job ATTACHED — an emergency at a
      // job must page the operator whose job it is, never degrade to a
      // context-free alert because of a bookkeeping mismatch.
      const claimedJobId: string = serviceJobId;
      const job = await runWithoutTenant(() => app.prisma.serviceJob.findFirst({
        where: {
          id: claimedJobId,
          OR: [{ customerId: request.user.userId }, { provider: { userId: request.user.userId } }],
        },
        select: { id: true, customerId: true, provider: { select: { userId: true } } },
      }));
      if (!job) {
        request.log.warn({ userId: request.user.userId, serviceJobId }, '[F-035-04] SOS service-job context did not resolve for this caller — degrading to a context-free alert');
        serviceJobId = null;
      } else {
        counterpartyUserId = [job.customerId, job.provider?.userId].find((u) => u && u !== request.user.userId) ?? null;
      }
    }

    // [F-026-14] OPS_MANUAL is a PROVENANCE claim ("ops raised this on the
    // person's behalf") and it skips the grace barrier. A client must not be
    // able to assert it: doing so both bypasses the reconsider window and
    // writes a false origin onto the highest-stakes record the system keeps.
    // Only a real ops caller may claim it; everyone else is a BUTTON press.
    const claimedSource = body.source === 'OPS_MANUAL' && isOps(request.user.role) ? 'OPS_MANUAL' : 'BUTTON';

    const alert = await sos.create({
      actorUserId: request.user.userId,
      actorRole: request.user.role,
      orderId,
      serviceJobId,
      orderType,
      counterpartyUserId,
      triggerSource: claimedSource,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      accuracyM: body.accuracyM ?? null,
      addressText: body.addressText ?? null,
      clientCreatedAt: body.clientCreatedAt ? new Date(body.clientCreatedAt) : null,
      // [F-026-17] Namespace the wire-supplied key. Server-derived keys live in
      // their own prefixes ("guardian:<sessionId>"), and a client that could
      // write into one could pre-claim — and so suppress — an escalation the
      // server raises on that person's behalf. Same doctrine as §4.1: a
      // coerced tap must never be able to switch help off.
      clientIdempotencyKey: body.clientIdempotencyKey ? `client:${body.clientIdempotencyKey}` : null,
    });
    return { success: true, data: { id: alert.id, status: alert.status, graceEndsAt: alert.graceEndsAt } };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/confirm', lifeSafety, async (request) => {
    await ownedAlert(request.params.id, request.user.userId);
    const a = await sos.confirm(request.params.id);
    return { success: true, data: { id: a.id, status: a.status } };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/cancel', lifeSafety, async (request) => {
    await ownedAlert(request.params.id, request.user.userId);
    const a = await sos.cancel(request.params.id);
    return { success: true, data: { id: a.id, status: a.status } };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/mark-safe', lifeSafety, async (request) => {
    await ownedAlert(request.params.id, request.user.userId);
    const a = await sos.markSafe(request.params.id);
    return { success: true, data: { id: a.id, status: a.status, userSafeFlaggedAt: a.userSafeFlaggedAt } };
  });

  app.get<{ Params: { id: string } }>('/sos/:id', auth, async (request) => {
    const a = await asResponder(request.user.role, () => app.prisma.sosAlert.findUnique({ where: { id: request.params.id } }));
    if (!a) throw new NotFoundError('SosAlert', request.params.id);
    if (a.actorUserId !== request.user.userId && !isOps(request.user.role)) throw new ForbiddenError('This is not your alert.');
    return { success: true, data: a };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/ack', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can acknowledge an alert.');
    const a = await asResponder(request.user.role, () => sos.ack(request.params.id, request.user.userId));
    return { success: true, data: { id: a.id, status: a.status, acknowledgedAt: a.acknowledgedAt } };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/resolve', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can resolve an alert.');
    const body = resolveSchema.parse(request.body ?? {});
    const a = await asResponder(request.user.role, () => sos.resolve(request.params.id, request.user.userId, body.resolutionCode, body.notes));
    return { success: true, data: { id: a.id, status: a.status, resolutionCode: a.resolutionCode } };
  });

  /** GET /sos — the ops war-room feed (§4.4). Ops-only. Fan-out pages + a socket
   *  event announce new alerts; this is what a console loads/reloads from so it
   *  never shows a blank board after a refresh or reconnect. `open` (default) is
   *  the un-closed set ops must act on; most-recent first. */
  app.get('/sos', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can list alerts.');
    const q = listAlertsQuery.parse(request.query ?? {});
    const where =
      q.status === 'active' ? { status: 'ACTIVE' as const }
      : q.status === 'all' ? {}
      : { status: { in: [...OPEN_STATUSES] } };
    const alerts = await asResponder(request.user.role, () => app.prisma.sosAlert.findMany({ where, orderBy: { triggeredAt: 'desc' }, take: q.limit }));
    return { success: true, data: alerts };
  });

  // ── Emergency contacts (safety §5) ───────────────────────────────────────
  // Every action is owner-scoped: the caller manages only their own contacts
  // (row-level check in the service). The confirmation code is proven by the
  // contact relaying it back, and reads never expose it.
  const contacts = new EmergencyContactService(app.prisma, app.redis, getChannels());
  const contactBody = z.object({
    name: z.string().trim().min(1).max(100),
    phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +5926001234.'),
    relationship: z.string().trim().max(50).optional(),
    priority: z.number().int().min(1).max(3).optional(),
  });

  app.get('/emergency-contacts', auth, async (request) => {
    return { success: true, data: await contacts.list(request.user.userId) };
  });

  app.post('/emergency-contacts', auth, async (request) => {
    const body = contactBody.parse(request.body ?? {});
    const { contact, codeSent } = await contacts.add({ userId: request.user.userId, ...body });
    return { success: true, data: { id: contact.id, name: contact.name, phoneE164: contact.phoneE164, relationship: contact.relationship, priority: contact.priority, verifiedAt: contact.verifiedAt, codeSent } };
  });

  app.post<{ Params: { id: string } }>('/emergency-contacts/:id/verify', auth, async (request) => {
    const { code } = z.object({ code: z.string().regex(/^\d{4,8}$/) }).parse(request.body ?? {});
    const c = await contacts.verify(request.user.userId, request.params.id, code);
    return { success: true, data: { id: c.id, verifiedAt: c.verifiedAt } };
  });

  app.post<{ Params: { id: string } }>('/emergency-contacts/:id/resend', auth, async (request) => {
    await contacts.resend(request.user.userId, request.params.id);
    return { success: true, data: { sent: true } };
  });

  app.delete<{ Params: { id: string } }>('/emergency-contacts/:id', auth, async (request) => {
    await contacts.remove(request.user.userId, request.params.id);
    return { success: true, data: { deleted: true } };
  });

  // ── Trip Share (safety §6) ───────────────────────────────────────────────
  // Mint/revoke are the passenger's own actions. The public read is
  // UNAUTHENTICATED BY DESIGN: the whole point is a recipient with no app and
  // no account following a live trip — the 128-bit token IS the credential,
  // it grants only this payload, and invalid/expired/revoked are one
  // indistinguishable null (no oracle).
  const { TripShareService } = await import('./trip-share.service');
  const tripShare = new TripShareService(app.prisma, app.redis, getChannels());

  app.post<{ Params: { id: string } }>('/trips/:id/share', auth, async (request) => {
    const body = z.object({
      sendToPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use international format.').optional(),
    }).parse(request.body ?? {});
    const share = await tripShare.mint(request.user.userId, request.params.id, body);
    return { success: true, data: share };
  });

  app.delete<{ Params: { token: string } }>('/share/:token', auth, async (request) => {
    return { success: true, data: await tripShare.revoke(request.user.userId, request.params.token) };
  });

  app.get<{ Params: { token: string } }>('/public/trip/:token', async (request, reply) => {
    const view = await tripShare.publicView(request.params.token);
    if (!view) {
      reply.code(404);
      return { success: false, error: { code: 'SHARE_NOT_AVAILABLE', message: 'This trip share is no longer available.' } };
    }
    return { success: true, data: view };
  });

  // ── Trip Guardian check-in responses (§5.3) ──────────────────────────────
  // Both resolve the session by the CALLER's identity — no ids are accepted,
  // so there is nothing cross-user to probe. The ladder itself (prompts,
  // deadline, auto-SOS) lives in the guardian sweep.
  const guardian = new GuardianService(app.prisma, app.io);

  // [F-027-17] These are life-safety routes too, and the exemption missed
  // them. A NEED_HELP check-in response mints an immediate ACTIVE SOS — it IS
  // the emergency button, wearing a check-in's clothes — so a person whose
  // ordinary request allowance was already spent could be answered 429 at the
  // exact moment they said they were in trouble.
  app.post('/guardian/checkin', lifeSafety, async (request) => {
    const { response } = z.object({ response: z.enum(['OK', 'NEED_HELP']) }).parse(request.body ?? {});
    return { success: true, data: await guardian.respondToCheckin(request.user.userId, response) };
  });

  // The READ half of the same question, for the caller's OWN trip only — the
  // service resolves the session from the authenticated user id and nothing
  // else, so there is no id to tamper with and no other passenger's trip to
  // reach. (`GET /guardian` above is the ops list and stays ops-only.)
  //
  // It exists because the check-in card had exactly one trigger: a live socket
  // event. A passenger whose app was closed when it fired — the case the push
  // is FOR — could not raise the card at all, and on a HARD check-in the
  // unanswered deadline escalates. Null when nothing is waiting: a screen must
  // be able to learn "no", not just "yes".
  app.get('/guardian/checkin', auth, async (request) => {
    return { success: true, data: await guardian.outstandingCheckin(request.user.userId) };
  });

  // [F-028-19] NOT lifeSafety. The exemption exists so a throttle can never
  // stand between a person and HELP — SOS, and a passenger's NEED_HELP. This
  // is the opposite message: a driver saying "I'm OK". Exempting an
  // acknowledgement handed a compromised or buggy driver client an unlimited
  // database-write + war-room-emit amplifier (every call rewrites the
  // session's JSON and pages the ops feed). The standard limiter is generous
  // beside any honest confirm cadence, and the service now short-circuits
  // repeats besides.
  // [S-04] A driver confirmation names the hard-check cycle it answers and
  // carries that cycle's one-time nonce; an unscoped tap is refused.
  app.post('/guardian/driver-confirm', { preHandler: [app.authenticate] }, async (request) => {
    const body = z.object({ cycleId: z.string().min(1).max(64), nonce: z.string().min(1).max(128), deviceId: z.string().max(128).optional() }).parse(request.body ?? {});
    return { success: true, data: await guardian.driverConfirm(request.user.userId, body) };
  });

  // ── Identity Assurance (§7.1) — the shift liveness check ────────────────
  // Multipart selfie in, §7.1 outcome out. The image is validated exactly like
  // the signup selfie (mime + magic bytes) and stored under liveness/ — the
  // review queue renders it next to the profile photo.
  const liveness = new LivenessService(app.prisma, app.io);

  app.post('/liveness-check', auth, async (request) => {
    const { profile } = z.object({ profile: z.enum(['DRIVER', 'RIDER']).default('DRIVER') }).parse(request.query ?? {});
    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a selfie image');
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      throw new AppError(400, 'BAD_IMAGE_TYPE', 'Only JPEG, PNG, or WebP images are accepted');
    }
    const buffer = await file.toBuffer();
    if (!looksLikeImage(buffer)) {
      throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
    }
    const { url } = await getStorageProvider().upload({
      buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder: `liveness/${request.user.userId}`,
    });
    const result = await liveness.check({ userId: request.user.userId, profile, selfieUrl: url });
    return { success: true, data: result };
  });

  /** §7.3 — "This isn't my driver", one tap on the arrival screen. Releases
   *  the ride to re-dispatch, locks + offlines the driver account, pages ops.
   *  Caller must be the ride's passenger; aboard-the-vehicle is SOS territory. */
  app.post<{ Params: { id: string } }>('/rides/:id/not-my-driver', auth, async (request) => {
    const result = await liveness.reportNotMyDriver(request.user.userId, request.params.id, async (orderId) => {
      if (app.dispatchQueue) {
        await app.dispatchQueue.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
      }
    });
    return { success: true, data: result };
  });

  // ── Incident Management (§8) ─────────────────────────────────────────────
  const incidents = new IncidentService(app.prisma, app.io);
  const reportWindowDays = () => {
    const v = Number(process.env['POST_TRIP_REPORT_WINDOW_DAYS']);
    return Number.isFinite(v) && v > 0 ? v : 30;
  };
  const USER_CATEGORIES = ['SAFETY_ASSAULT', 'SAFETY_THREAT', 'SAFETY_HARASSMENT', 'DRIVING_DANGEROUS', 'IDENTITY_MISMATCH', 'CASH_DISPUTE', 'OTHER'] as const;

  /** §8.1 in-trip / post-trip report — "not an emergency, but something's
   *  wrong". Caller must be a participant on the order; the SUBJECT is the
   *  other party. Reporter identity is stored but never subject-visible. */
  app.post('/incidents', auth, async (request) => {
    const body = z.object({
      // [S-08] A retried report is the same report: the client's key, else reporter × order × category.
      idempotencyKey: z.string().trim().min(1).max(80).optional(),
      orderId: z.string().min(1),
      category: z.enum(USER_CATEGORIES),
      summary: z.string().trim().min(5).max(2000),
    }).parse(request.body ?? {});

    const order = await app.prisma.order.findFirst({
      where: {
        id: body.orderId,
        OR: [{ customerId: request.user.userId }, { driver: { userId: request.user.userId } }, { rider: { userId: request.user.userId } }],
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        customerId: true,
        driver: { select: { userId: true } },
        rider: { select: { userId: true } },
      },
    });
    if (!order) throw new NotFoundError('Order', body.orderId);
    if (Date.now() - order.createdAt.getTime() > reportWindowDays() * 86_400_000) {
      throw new AppError(410, 'REPORT_WINDOW_CLOSED', `Reports are accepted up to ${reportWindowDays()} days after a trip — contact support instead.`);
    }
    const subjectUserId = [order.customerId, order.driver?.userId, order.rider?.userId].find((u) => u && u !== request.user.userId) ?? null;
    if (!subjectUserId) throw new AppError(409, 'NO_COUNTERPARTY', 'There is no other party on this order to report yet.');

    const TERMINAL = ['COMPLETED', 'DELIVERED', 'CANCELLED', 'FAILED'];
    const kase = await incidents.intake({
      category: body.category,
      intake: TERMINAL.includes(order.status) ? 'POST_TRIP_REPORT' : 'IN_TRIP_REPORT',
      subjectUserId,
      reporterUserId: request.user.userId,
      orderId: order.id,
      summary: body.summary,
      source: { type: 'REPORT', id: body.idempotencyKey ? `key:${request.user.userId}:${body.idempotencyKey}` : `${request.user.userId}:${order.id}:${body.category}` },
    });
    // The reporter sees their case handle — never the machinery around the subject.
    return { success: true, data: { caseNumber: kase.caseNumber, status: kase.status } };
  });

  /** Ops intake — phone call / email / social report, logged by a human. */
  app.post('/incidents/ops', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can log a case directly.');
    const body = z.object({
      // [S-08] An ops-logged report retried with the same key is one case.
      idempotencyKey: z.string().trim().min(1).max(80).optional(),
      subjectUserId: z.string().min(1),
      category: z.string().trim().min(2).max(60),
      severity: z.enum(['S0', 'S1', 'S2', 'S3', 'S4']).optional(),
      orderId: z.string().optional(),
      sosAlertId: z.string().optional(),
      summary: z.string().trim().min(5).max(2000),
    }).parse(request.body ?? {});
    const { idempotencyKey, ...intakeBody } = body;
    const kase = await incidents.intake({ ...intakeBody, intake: 'OPS_CREATED', reporterUserId: null, source: idempotencyKey ? { type: 'OPS', id: `${request.user.userId}:${idempotencyKey}` } : null });
    return { success: true, data: kase };
  });

  /** The ops case queue. `open` = everything not CLOSED, severity-first;
   *  `breached` = SLA clocks already blown (indexed reads, §8.2). */
  /** [S-08] Merge is an explicit analyst action — never automatic. */
  app.post('/incidents/:id/merge', auth, async (request) => {
    const { id } = request.params as { id: string };
    const { intoCaseId } = z.object({ intoCaseId: z.string().min(1) }).parse(request.body ?? {});
    return { success: true, data: await incidents.mergeDuplicate(id, intoCaseId, request.user.userId) };
  });

  app.get('/incidents', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can list cases.');
    const q = z.object({
      status: z.enum(['open', 'breached', 'all']).default('open'),
      // [REPORT-007 / SPS-F-0025] The queue was a single bounded page: with
      // severity-first ordering, any row ranked below the first `limit` was
      // UNREACHABLE through the API — an S3 dispute could sit breached forever
      // behind older S0/S1 rows with no way to page to it. Offset pagination +
      // a stable id tie-break makes every qualifying row reachable; a cursor
      // (and the spec's outstanding-SLA ordering) is the registered follow-up
      // when the queue contract is formalized.
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query ?? {});
    const now = new Date();
    const where =
      q.status === 'all' ? {}
      : q.status === 'breached'
        ? { status: { not: 'CLOSED' as const }, OR: [{ ackedAt: null, slaAckBy: { lt: now } }, { decidedAt: null, slaDecideBy: { lt: now } }] }
        : { status: { not: 'CLOSED' as const } };
    const cases = await app.prisma.incidentCase.findMany({
      where,
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    });
    return { success: true, data: cases };
  });

  const opsCaseAction = (fn: (id: string, opsUserId: string) => Promise<unknown>) =>
    async (request: { user: { userId: string; role: string }; params: { id: string } }) => {
      if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can work a case.');
      return { success: true, data: await fn(request.params.id, request.user.userId) };
    };

  app.post<{ Params: { id: string } }>('/incidents/:id/ack', auth, opsCaseAction((id, ops) => incidents.ack(id, ops)));
  app.post<{ Params: { id: string } }>('/incidents/:id/investigate', auth, opsCaseAction((id, ops) => incidents.investigate(id, ops)));
  app.post<{ Params: { id: string } }>('/incidents/:id/close', auth, opsCaseAction((id, ops) => incidents.close(id, ops)));
  app.post<{ Params: { id: string } }>('/incidents/:id/escalate-police', auth, opsCaseAction((id, ops) => incidents.escalatePolice(id, ops)));
  app.post<{ Params: { id: string } }>('/incidents/:id/lift-interim', auth, opsCaseAction((id, ops) => incidents.liftInterim(id, ops)));
  app.post<{ Params: { id: string } }>('/incidents/:id/shadow-restrict', auth, opsCaseAction((id, ops) => incidents.shadowRestrict(id, ops)));

  app.post<{ Params: { id: string } }>('/incidents/:id/decide', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can work a case.');
    const body = z.object({
      decisionCode: z.enum(DECISION_CODES),
      notes: z.string().max(4000).optional(),
    }).parse(request.body ?? {});
    return { success: true, data: await incidents.decide(request.params.id, request.user.userId, body.decisionCode, body.notes) };
  });

  // ── Evidence Vault (§9) — ops-only; content never moves without a logged
  //    reason (chain of custody). ────────────────────────────────────────────
  const evidence = new EvidenceService(app.prisma, app.io);
  const reasonBody = z.object({ reason: z.string().trim().min(5).max(1000) });

  /** Meta lookup (no content, no log): find the bundle behind a case/alert. */
  app.get('/evidence', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can access evidence.');
    const q = z.object({ caseId: z.string().optional(), sosAlertId: z.string().optional() }).parse(request.query ?? {});
    if (!q.caseId && !q.sosAlertId) throw new AppError(400, 'LINK_REQUIRED', 'Pass caseId or sosAlertId.');
    const bundle = await app.prisma.evidenceBundle.findFirst({
      where: q.caseId ? { caseId: q.caseId } : { sosAlertId: q.sosAlertId },
      select: { id: true, bundleNumber: true, sosAlertId: true, caseId: true, subjectUserId: true, openedAt: true, sealedAt: true, sealHash: true, legalHold: true, _count: { select: { items: true } } },
    });
    if (!bundle) throw new NotFoundError('EvidenceBundle', q.caseId ?? q.sosAlertId ?? '');
    return { success: true, data: bundle };
  });

  app.post<{ Params: { id: string } }>('/evidence/:id/view', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can access evidence.');
    const { reason } = reasonBody.parse(request.body ?? {});
    return { success: true, data: await evidence.view(request.params.id, request.user.userId, reason) };
  });

  app.post<{ Params: { id: string } }>('/evidence/:id/seal', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can seal evidence.');
    const { reason } = reasonBody.parse(request.body ?? {});
    return { success: true, data: await evidence.seal(request.params.id, request.user.userId, reason) };
  });

  app.post<{ Params: { id: string } }>('/evidence/:id/legal-hold', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can set a legal hold.');
    const { reason } = reasonBody.parse(request.body ?? {});
    return { success: true, data: await evidence.setLegalHold(request.params.id, request.user.userId, reason) };
  });

  /** §9.2 export — encrypted + watermarked, passphrase returned exactly once
   *  (hand it over on a separate channel; Swift keeps no copy). */
  app.post<{ Params: { id: string } }>('/evidence/:id/export', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can export evidence.');
    const { reason } = reasonBody.parse(request.body ?? {});
    return { success: true, data: await evidence.export(request.params.id, request.user.userId, reason) };
  });

  // §5.1 enhanced-monitoring preference — the "Extra safety check-ins on my
  // trips" toggle. Strictly the caller's OWN row; the server never infers it.
  app.put('/monitoring-preference', auth, async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body ?? {});
    const user = await app.prisma.user.update({
      where: { id: request.user.userId },
      data: { enhancedSafetyMonitoring: enabled },
      select: { enhancedSafetyMonitoring: true },
    });
    return { success: true, data: user };
  });

  app.get('/monitoring-preference', auth, async (request) => {
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: { enhancedSafetyMonitoring: true },
    });
    return { success: true, data: user };
  });

  /** GET /guardian — the ops live-monitoring board (§5.1: HIGH trips appear
   *  proactively; this is what the war-room loads/reloads from). Ops-only. */
  const listSessionsQuery = z.object({
    status: z.enum(['live', 'flagged', 'all']).default('live'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });
  app.get('/guardian', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can list guardian sessions.');
    const q = listSessionsQuery.parse(request.query ?? {});
    const where =
      q.status === 'all' ? {}
      : q.status === 'flagged' ? { status: { in: ['CHECKIN_PENDING', 'ESCALATING'] as never[] } }
      : { status: { in: ['MONITORING', 'CHECKIN_PENDING', 'ESCALATING'] as never[] } };
    const sessions = await app.prisma.tripSafetySession.findMany({
      where,
      orderBy: [{ riskScore: 'desc' }, { createdAt: 'desc' }],
      take: q.limit,
    });
    return { success: true, data: sessions };
  });
}
