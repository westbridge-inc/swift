import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SosService } from './sos.service';
import { GuardianService } from './guardian.service';
import { EmergencyContactService } from './emergency-contact.service';
import { getChannels } from '../../providers/notifications/channels';
import { NotFoundError, ForbiddenError } from '../../utils/errors';

// SOS endpoints (safety spec §4.5). The engine (state machine, grace, fan-out)
// lives in SosService; these are thin, authed wrappers. Owner actions require
// the caller to be the alert's actor; ack/resolve are ops-only.
const createSchema = z.object({
  orderId: z.string().min(1).optional(),
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

  async function ownedAlert(id: string, userId: string) {
    const a = await app.prisma.sosAlert.findUnique({ where: { id } });
    if (!a) throw new NotFoundError('SosAlert', id);
    if (a.actorUserId !== userId) throw new ForbiddenError('This is not your alert.');
    return a;
  }

  /** POST /sos — raise an alert (grace window opens unless ops-raised). */
  app.post('/sos', auth, async (request) => {
    const body = createSchema.parse(request.body ?? {});

    let counterpartyUserId: string | null = null;
    let orderType: import('@prisma/client').OrderType | null = null;
    if (body.orderId) {
      // Only a participant on THIS order may raise its SOS (§4.5 authz).
      const order = await app.prisma.order.findFirst({
        where: {
          id: body.orderId,
          OR: [{ customerId: request.user.userId }, { driver: { userId: request.user.userId } }, { rider: { userId: request.user.userId } }],
        },
        select: { id: true, orderType: true, customerId: true, driver: { select: { userId: true } }, rider: { select: { userId: true } } },
      });
      if (!order) throw new NotFoundError('Order', body.orderId);
      orderType = order.orderType;
      counterpartyUserId = [order.customerId, order.driver?.userId, order.rider?.userId].find((u) => u && u !== request.user.userId) ?? null;
    }

    const alert = await sos.create({
      actorUserId: request.user.userId,
      actorRole: request.user.role,
      orderId: body.orderId ?? null,
      orderType,
      counterpartyUserId,
      triggerSource: body.source ?? 'BUTTON',
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      accuracyM: body.accuracyM ?? null,
      addressText: body.addressText ?? null,
      clientCreatedAt: body.clientCreatedAt ? new Date(body.clientCreatedAt) : null,
      clientIdempotencyKey: body.clientIdempotencyKey ?? null,
    });
    return { success: true, data: { id: alert.id, status: alert.status, graceEndsAt: alert.graceEndsAt } };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/confirm', auth, async (request) => {
    await ownedAlert(request.params.id, request.user.userId);
    const a = await sos.confirm(request.params.id);
    return { success: true, data: { id: a.id, status: a.status } };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/cancel', auth, async (request) => {
    await ownedAlert(request.params.id, request.user.userId);
    const a = await sos.cancel(request.params.id);
    return { success: true, data: { id: a.id, status: a.status } };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/mark-safe', auth, async (request) => {
    await ownedAlert(request.params.id, request.user.userId);
    const a = await sos.markSafe(request.params.id);
    return { success: true, data: { id: a.id, status: a.status, userSafeFlaggedAt: a.userSafeFlaggedAt } };
  });

  app.get<{ Params: { id: string } }>('/sos/:id', auth, async (request) => {
    const a = await app.prisma.sosAlert.findUnique({ where: { id: request.params.id } });
    if (!a) throw new NotFoundError('SosAlert', request.params.id);
    if (a.actorUserId !== request.user.userId && !isOps(request.user.role)) throw new ForbiddenError('This is not your alert.');
    return { success: true, data: a };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/ack', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can acknowledge an alert.');
    const a = await sos.ack(request.params.id, request.user.userId);
    return { success: true, data: { id: a.id, status: a.status, acknowledgedAt: a.acknowledgedAt } };
  });

  app.post<{ Params: { id: string } }>('/sos/:id/resolve', auth, async (request) => {
    if (!isOps(request.user.role)) throw new ForbiddenError('Only ops can resolve an alert.');
    const body = resolveSchema.parse(request.body ?? {});
    const a = await sos.resolve(request.params.id, request.user.userId, body.resolutionCode, body.notes);
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
    const alerts = await app.prisma.sosAlert.findMany({ where, orderBy: { triggeredAt: 'desc' }, take: q.limit });
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

  // ── Trip Guardian check-in responses (§5.3) ──────────────────────────────
  // Both resolve the session by the CALLER's identity — no ids are accepted,
  // so there is nothing cross-user to probe. The ladder itself (prompts,
  // deadline, auto-SOS) lives in the guardian sweep.
  const guardian = new GuardianService(app.prisma, app.io);

  app.post('/guardian/checkin', auth, async (request) => {
    const { response } = z.object({ response: z.enum(['OK', 'NEED_HELP']) }).parse(request.body ?? {});
    return { success: true, data: await guardian.respondToCheckin(request.user.userId, response) };
  });

  app.post('/guardian/driver-confirm', auth, async (request) => {
    return { success: true, data: await guardian.driverConfirm(request.user.userId) };
  });
}
