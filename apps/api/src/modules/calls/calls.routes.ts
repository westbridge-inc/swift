import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { NotificationService } from '../notification/notification.service';
import type { CallProvider } from '../../providers/voice/call-provider';
import { TwilioVoiceProvider } from '../../providers/voice/twilio-voice';
import { callRelayEnabled, readCallRelayConfig, type CallRelayConfig } from './call-relay-switch';
import { CALL_STEPS, CALL_TARGETS, handleVoiceStep, startBridgeCall, type CallBridgeDeps, type CallStepName } from './call-bridge';

// ---------------------------------------------------------------------------
// [O-1] The Swift call bridge's two doors.
//
// callsRoutes (/api/v1/calls, signed-in parties):
//   GET  /config  -> is "Call via Swift" on, and Swift's number for the
//                    "Save Swift's call number" tip (null while off);
//   POST /bridge  -> { orderId, target } starts a bridged call (403
//                    CALL_RELAY_OFF while the switch is off: nothing is dialled,
//                    no row is written, no push is sent).
// callVoiceRoutes (/api/v1/calls/voice, the voice provider only):
//   POST /:step?s=<call id> for each step of a call, and POST /inbound for a
//   call back to Swift's number. Every request is refused (403) unless the
//   provider signed it over the exact URL; 503 while unconfigured.
// ---------------------------------------------------------------------------

export interface CallRoutesOptions {
  /** Tests inject a provider that never reaches a network. */
  provider?: (config: CallRelayConfig) => CallProvider;
}

const defaultProvider = (config: CallRelayConfig): CallProvider => new TwilioVoiceProvider(config.twilio);

/** The bridge's settings while CALL_RELAY is on; null while it is off or incomplete (boot refuses the latter in every mode). */
function liveConfig(env: Record<string, string | undefined> = process.env): CallRelayConfig | null {
  if (!callRelayEnabled(env)) return null;
  const read = readCallRelayConfig(env);
  return read.ok ? read.config : null;
}

const bridgeBody = z.object({
  orderId: z.string().min(1).max(64),
  target: z.enum(CALL_TARGETS),
});

export async function callsRoutes(app: FastifyInstance, opts: CallRoutesOptions = {}): Promise<void> {
  const notifications = new NotificationService(app.prisma, app.io);
  const providerFor = opts.provider ?? defaultProvider;

  app.get('/config', { preHandler: [app.authenticate] }, async () => {
    const config = liveConfig();
    return { success: true, data: { enabled: config !== null, callerId: config?.callerId ?? null } };
  });

  app.post('/bridge', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const config = liveConfig();
    if (!config) {
      throw new AppError(403, 'CALL_RELAY_OFF', 'Calls through Swift are not on yet. Message them in chat, or ask support to connect you.');
    }
    const { orderId, target } = bridgeBody.parse(request.body);
    const deps: CallBridgeDeps = { prisma: app.prisma, provider: providerFor(config), config, notifications };
    const result = await startBridgeCall(deps, { orderId, target, userId: request.user.userId });
    return { success: true, data: result };
  });
}

// ---------------------------------------------------------------------------
// The provider's webhooks.
// ---------------------------------------------------------------------------

export const CALL_WEBHOOK_BODY_LIMIT = 16 * 1024;
const CALL_WEBHOOK_RATE = { max: 600, timeWindow: '1 minute' } as const;
const MAX_FIELDS = 64;
/** What a call back to Swift's number hears: never forwarded to anyone (a stranger could reach a person). */
export const INBOUND_CALL_WORDS = 'This is Swift. To reach your rider, driver, store or customer, please call from the Swift app. Goodbye.';

type FormFields = Record<string, string[]>;

function parseForm(text: string): FormFields {
  const out: FormFields = Object.create(null);
  let count = 0;
  for (const [key, value] of new URLSearchParams(text)) {
    if (++count > MAX_FIELDS) throw new Error('too many form fields');
    (out[key] ??= []).push(value);
  }
  return out;
}

function isFormFields(value: unknown): value is FormFields {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

/** The exact URL the provider called: the configured public base + this route's tail, query included. */
function calledUrl(config: CallRelayConfig, request: FastifyRequest, tail: string): string {
  const raw = request.raw.url ?? '';
  const q = raw.indexOf('?');
  return `${config.webhookBase}/${tail}${q >= 0 ? raw.slice(q) : ''}`;
}

export async function callVoiceRoutes(app: FastifyInstance, opts: CallRoutesOptions = {}): Promise<void> {
  const notifications = new NotificationService(app.prisma, app.io);
  const providerFor = opts.provider ?? defaultProvider;

  // The provider posts a form; scoped to these routes (the server has no global form parser).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: CALL_WEBHOOK_BODY_LIMIT }, (_request, body, done) => {
    try {
      done(null, parseForm(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const routeOptions = {
    bodyLimit: CALL_WEBHOOK_BODY_LIMIT,
    config: { rateLimit: { ...CALL_WEBHOOK_RATE, keyGenerator: (request: FastifyRequest) => request.ip } },
  };

  /** Configured and signed, or the refusal. Never reads the body before the signature. */
  function admit(request: FastifyRequest, reply: FastifyReply, tail: string): { config: CallRelayConfig; provider: CallProvider; fields: FormFields } | null {
    // Signatures are checked with the settings even while CALL_RELAY is off, so a call that was
    // ringing when the switch went off is still answered (with a hang-up), never left to the provider.
    const read = readCallRelayConfig();
    if (!read.ok) {
      void reply.code(503).type('text/plain').send('not configured');
      return null;
    }
    const provider = providerFor(read.config);
    const fields = isFormFields(request.body) ? request.body : null;
    if (!fields || !provider.verify({ url: calledUrl(read.config, request, tail), fields, signature: request.headers['x-twilio-signature'] })) {
      log().warn('[O-1] call webhook refused: missing or wrong provider signature');
      void reply.code(403).type('text/plain').send('forbidden');
      return null;
    }
    return { config: read.config, provider, fields };
  }

  app.post('/inbound', routeOptions, async (request, reply) => {
    const admitted = admit(request, reply, 'inbound');
    if (!admitted) return reply;
    const out = admitted.provider.render({ verb: 'hangup', say: INBOUND_CALL_WORDS });
    return reply.type(out.contentType).send(out.body);
  });

  app.post<{ Params: { step: string }; Querystring: { s?: string } }>('/:step', routeOptions, async (request, reply) => {
    const step = request.params.step as CallStepName;
    if (!(CALL_STEPS as readonly string[]).includes(step)) return reply.code(404).type('text/plain').send('not found');
    const admitted = admit(request, reply, step);
    if (!admitted) return reply;
    const sessionId = typeof request.query.s === 'string' ? request.query.s : '';
    const deps: CallBridgeDeps = { prisma: app.prisma, provider: admitted.provider, config: admitted.config, notifications };
    // The call's own operator: read once as system work, then everything runs inside that tenant.
    const tenantId = sessionId
      ? await runAsSystem('call-bridge-webhook', () => app.prisma.callSession.findUnique({ where: { id: sessionId }, select: { tenantId: true } }).catch(() => null))
      : null;
    const result = tenantId
      ? await runWithTenant(tenantId.tenantId, () => handleVoiceStep(deps, step, sessionId, { fields: admitted.fields }, callRelayEnabled()))
      : { step: step === 'status' ? null : ({ verb: 'hangup' } as const) };
    if (!result.step) return reply.code(204).send();
    const out = admitted.provider.render(result.step);
    return reply.type(out.contentType).send(out.body);
  });
}
