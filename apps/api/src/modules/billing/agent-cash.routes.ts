import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BillingService } from './billing.service';
import { AgentCashService } from './agent-cash.service';
import { resolveSan } from './san.service';
import { validateSanShape, maskDisplayName, formatSan } from './san';
import { NotificationService } from '../notification/notification.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';

// Channel A (webhook) + Channel A' (bill inquiry) [san spec 4.1/4.2] —
// BUILT FIRST, ENABLED LAST: both 503 until AGENT_CASH_WEBHOOK_SECRET is
// configured (MMG biller onboarding, LAUNCH_BLOCKERS Q1-8). Auth is an HMAC
// over `${timestamp}.${rawBody}` with ±5min freshness — the same shared-
// secret idiom as ADS_EVENT_SECRET; the MMG adapter swaps in their real
// scheme when Q2 is answered. 401 exists ONLY for signature failure — an
// unknown SAN is 200 received_unmatched, because the cash already changed
// hands (SO-6).

const FRESHNESS_MS = 5 * 60_000;

function secret(): string | null {
  const s = process.env['AGENT_CASH_WEBHOOK_SECRET'];
  if (!s || s.length < 16) return null;
  return s;
}

function verifySignature(req: FastifyRequest): { ok: boolean; code?: string } {
  const s = secret();
  if (!s) return { ok: false, code: 'CHANNEL_DISABLED' };
  const ts = String(req.headers['x-swift-timestamp'] ?? '');
  const sig = String(req.headers['x-swift-signature'] ?? '');
  if (!ts || !sig) return { ok: false, code: 'SIGNATURE_MISSING' };
  const age = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(age) || age > FRESHNESS_MS) return { ok: false, code: 'STALE_TIMESTAMP' };
  const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  const expected = createHmac('sha256', s).update(`${ts}.`).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 'BAD_SIGNATURE' };
  return { ok: true };
}

export async function agentCashRoutes(app: FastifyInstance) {
  // Scoped raw-body capture: signature verification needs the exact bytes
  // BEFORE JSON parsing; encapsulation keeps this off every other route.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8') || '{}'));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  const notifications = new NotificationService(app.prisma, app.io);
  const billing = new BillingService(app.prisma, notifications, getPaymentProvider());
  const svc = new AgentCashService(app.prisma, billing);

  /** Channel A — real-time agent-payment notification. */
  app.post('/agent-notification', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = verifySignature(request);
    if (!auth.ok) {
      if (auth.code === 'CHANNEL_DISABLED') return reply.status(503).send({ status: 'channel_disabled' });
      return reply.status(401).send({ status: 'unauthorized', code: auth.code });
    }
    const body = z.object({
      transactionId: z.string().min(1).max(80),
      accountNumber: z.string().min(1).max(30),
      amount: z.number().positive(),
      currency: z.string().length(3).default('GYD'),
      paidAt: z.string().datetime().optional(),
      agentId: z.string().max(80).optional(),
      payerMsisdn: z.string().max(30).optional(),
    }).parse(request.body ?? {});

    const result = await svc.ingest({
      externalId: body.transactionId,
      channel: 'MMG_AGENT_WEBHOOK',
      mmgTxnId: body.transactionId,
      sanRaw: body.accountNumber,
      amount: body.amount,
      currencyCode: body.currency,
      paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
      agentRef: body.agentId,
      payerMsisdn: body.payerMsisdn,
      raw: request.body as never,
    });
    // 200 always once we own the money [spec 4.1].
    return reply.status(200).send(
      result.status === 'accepted'
        ? { status: 'accepted' }
        : result.status === 'duplicate' || result.status === 'reconciled'
          ? { status: 'duplicate' }
          : { status: 'received_unmatched' },
    );
  });

  /** Channel A' — bill inquiry, THE TYPO-KILLER [4.2]: the agent keys the
   *  number BEFORE taking cash; the payer confirms the masked name. */
  app.post('/inquiry', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const auth = verifySignature(request);
    if (!auth.ok) {
      if (auth.code === 'CHANNEL_DISABLED') return reply.status(503).send({ status: 'channel_disabled' });
      return reply.status(401).send({ status: 'unauthorized', code: auth.code });
    }
    const body = z.object({ accountNumber: z.string().min(1).max(30) }).parse(request.body ?? {});
    const shape = validateSanShape(body.accountNumber);
    if (!shape.ok) return reply.send({ valid: false, reason: shape.code });
    const res = await resolveSan(app.prisma, shape.san);
    if (!res.ok) return reply.send({ valid: false, reason: res.code });

    const sub = res.subscription;
    const [vendor, balance] = await Promise.all([
      sub.vendorId ? app.prisma.vendor.findUnique({ where: { id: sub.vendorId }, select: { name: true, city: true } }) : null,
      app.prisma.prepaidBalance.findUnique({ where: { subscriptionId: sub.id } }),
    ]);
    let holderName = 'Swift partner';
    let city: string | null = null;
    if (vendor) {
      holderName = vendor.name;
      city = vendor.city;
    } else {
      const person = sub.riderId
        ? await app.prisma.rider.findUnique({ where: { id: sub.riderId }, select: { user: { select: { firstName: true } } } })
        : sub.driverId
          ? await app.prisma.driver.findUnique({ where: { id: sub.driverId }, select: { user: { select: { firstName: true } } } })
          : null;
      if (person) holderName = person.user.firstName;
    }
    // Amount-due math [3.4], the single source of truth: next week's fee
    // minus whatever already sits in the wallet, floored at zero.
    const weekly = Number(sub.customRate ?? sub.weeklyRate);
    const amountDue = Math.max(0, weekly - Number(balance?.balance ?? 0));
    return reply.send({
      valid: true,
      displayName: maskDisplayName(holderName, city),
      accountNumber: formatSan(shape.san),
      amountDueGyd: amountDue.toFixed(2),
      weeklyFeeGyd: weekly.toFixed(2),
      currency: 'GYD',
    });
  });
}
