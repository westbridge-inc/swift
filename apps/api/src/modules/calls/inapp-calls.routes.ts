import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import type { CallProvider } from '../../providers/voice/call-provider';
import { TwilioVoiceProvider } from '../../providers/voice/twilio-voice';
import { callRelayEnabled, readCallRelayConfig } from './call-relay-switch';
import { CALL_TARGETS, type ServiceDayLedger } from './call-bridge';
import { dailyCapNotice, redisServiceDayLedger } from './calls.routes';
import { inAppCallsEnabled, readInAppCallsConfig, type InAppCallsConfig } from './inapp-calls-switch';
import {
  INAPP_STEPS,
  cancelUntakenCall,
  handleInAppStep,
  issueSessionToken,
  startInAppCall,
  type InAppDeps,
  type InAppStepName,
} from './inapp-calls';

// ---------------------------------------------------------------------------
// [INAPP-CALLS] In-app calling's two doors.
//
// inAppCallsRoutes (/api/v1/calls/app, signed-in):
//   GET  /config            -> { enabled }
//   POST /token             -> { platform, purpose } a short token for THIS session's identity only:
//                              register (live-order parties only) or unregister (sign-out / account switch)
//   POST /                  -> { orderId, target, platform } start a call; { callId, token }
//   POST /:callId/cancel    -> the caller's phone could not connect: free the order at once
//   All refuse 403 INAPP_CALLS_OFF while the switch is off: nothing is issued, written or rung.
// inAppVoiceRoutes (/api/v1/calls/voice, Twilio only): POST /app (the TwiML App's voice URL),
//   /app-answered, /app-dial-done, /app-status. Every request is refused (403) unless Twilio signed it
//   over the exact URL; 503 while unconfigured.
// ---------------------------------------------------------------------------

export interface InAppRoutesOptions {
  /** Tests inject a provider that never reaches a network (signature checks + rendering). */
  provider?: (twilio: InAppCallsConfig['twilio']) => CallProvider;
  /** Tests may inject the service's daily list; by default it is the bridge's list in Redis (one budget). */
  ledger?: ServiceDayLedger;
}

const defaultProvider = (twilio: InAppCallsConfig['twilio']): CallProvider => new TwilioVoiceProvider(twilio);

function liveConfig(env: Record<string, string | undefined> = process.env): InAppCallsConfig | null {
  if (!inAppCallsEnabled(env)) return null;
  const read = readInAppCallsConfig(env);
  return read.ok ? read.config : null;
}

/** The phone bridge, for the fallback leg, only while CALL_RELAY is on and complete. */
function liveRelay(providerFor: (twilio: InAppCallsConfig['twilio']) => CallProvider): InAppDeps['relay'] {
  if (!callRelayEnabled()) return null;
  const read = readCallRelayConfig();
  return read.ok ? { config: read.config, provider: providerFor(read.config.twilio) } : null;
}

const OFF = () => new AppError(403, 'INAPP_CALLS_OFF', 'In-app calls are not on yet. Use Call via Swift, or message them in chat.');
const tokenBody = z.object({ platform: z.enum(['ios', 'android']), purpose: z.enum(['register', 'unregister']).default('register') });
const startBody = z.object({ orderId: z.string().min(1).max(64), target: z.enum(CALL_TARGETS), platform: z.enum(['ios', 'android']) });
const callIdParam = z.object({ callId: z.string().min(1).max(40) });

export async function inAppCallsRoutes(app: FastifyInstance, opts: InAppRoutesOptions = {}): Promise<void> {
  const notifications = new NotificationService(app.prisma, app.io);
  const providerFor = opts.provider ?? defaultProvider;
  const depsFor = (config: InAppCallsConfig): InAppDeps => ({
    prisma: app.prisma, config, relay: liveRelay(providerFor), notifications,
    ledger: opts.ledger ?? redisServiceDayLedger(app.redis),
    // [REVIEW-G23 S3-2] The bridge's own operator notice, deduped with it once per UTC day.
    alertDailyCap: async (max) => {
      const words = dailyCapNotice(max);
      await notifyAdmins(app.prisma, notifications, {
        ...words, tenantId: null, data: { kind: 'call_daily_cap' },
        dedupeKey: `call-daily-cap:${new Date().toISOString().slice(0, 10)}`,
      });
    },
  });

  app.get('/config', { preHandler: [app.authenticate] }, async () => ({ success: true, data: { enabled: liveConfig() !== null } }));

  app.post('/token', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request) => {
    const config = liveConfig();
    if (!config) throw OFF();
    const { platform, purpose } = tokenBody.parse(request.body);
    // Only ever this request's own session (its identity rotates on sign-out); never one named by the client.
    return { success: true, data: await issueSessionToken(depsFor(config), { userId: request.user.userId, sessionId: request.authSessionId, platform, purpose }) };
  });

  app.post('/', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const config = liveConfig();
    if (!config) throw OFF();
    const { orderId, target, platform } = startBody.parse(request.body);
    return { success: true, data: await startInAppCall(depsFor(config), { orderId, target, platform, userId: request.user.userId, sessionId: request.authSessionId }) };
  });

  app.post('/:callId/cancel', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request) => {
    const config = liveConfig();
    if (!config) throw OFF();
    const { callId } = callIdParam.parse(request.params);
    await cancelUntakenCall(depsFor(config), request.user.userId, callId);
    return { success: true, data: { ended: true } };
  });
}

// ---------------------------------------------------------------------------
// Twilio's webhooks for in-app calls.
// ---------------------------------------------------------------------------

const WEBHOOK_BODY_LIMIT = 16 * 1024;
const WEBHOOK_RATE = { max: 600, timeWindow: '1 minute' } as const;
const MAX_FIELDS = 64;

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

export async function inAppVoiceRoutes(app: FastifyInstance, opts: InAppRoutesOptions = {}): Promise<void> {
  const notifications = new NotificationService(app.prisma, app.io);
  const providerFor = opts.provider ?? defaultProvider;

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => {
    try {
      done(null, parseForm(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const routeOptions = {
    bodyLimit: WEBHOOK_BODY_LIMIT,
    config: { rateLimit: { ...WEBHOOK_RATE, keyGenerator: (request: FastifyRequest) => request.ip } },
  };

  /** Configured and signed, or the refusal. Checked even while the switch is off, so a ringing call is hung up, not left. */
  function admit(request: FastifyRequest, reply: FastifyReply, step: InAppStepName): { config: InAppCallsConfig; provider: CallProvider; fields: FormFields } | null {
    const read = readInAppCallsConfig();
    if (!read.ok) {
      void reply.code(503).type('text/plain').send('not configured');
      return null;
    }
    const provider = providerFor(read.config.twilio);
    const raw = request.raw.url ?? '';
    const q = raw.indexOf('?');
    const url = `${read.config.webhookBase}/${step}${q >= 0 ? raw.slice(q) : ''}`;
    const fields = isFormFields(request.body) ? request.body : null;
    if (!fields || !provider.verify({ url, fields, signature: request.headers['x-twilio-signature'] })) {
      log().warn('[INAPP-CALLS] call webhook refused: missing or wrong provider signature');
      void reply.code(403).type('text/plain').send('forbidden');
      return null;
    }
    return { config: read.config, provider, fields };
  }

  for (const step of INAPP_STEPS) {
    app.post<{ Querystring: { s?: string } }>(`/${step}`, routeOptions, async (request, reply) => {
      const admitted = admit(request, reply, step);
      if (!admitted) return reply;
      const deps: InAppDeps = { prisma: app.prisma, config: admitted.config, relay: liveRelay(providerFor), notifications };
      // The call id: from Swift's own step URL, or (the first step) from the caller's connect parameters.
      const callId = step === 'app' ? admitted.fields['callId']?.[0] ?? '' : typeof request.query.s === 'string' ? request.query.s : '';
      const sid = admitted.fields['CallSid']?.[0] ?? '';
      // The call's own operator: read once as system work, then everything runs inside that tenant.
      const row = await runAsSystem('inapp-call-webhook', () => (step === 'app-status'
        ? (sid ? app.prisma.callSession.findUnique({ where: { providerCallId: sid }, select: { tenantId: true } }) : Promise.resolve(null))
        : (callId ? app.prisma.callSession.findUnique({ where: { id: callId }, select: { tenantId: true } }) : Promise.resolve(null))
      ).catch(() => null));
      const result = row
        ? await runWithTenant(row.tenantId, () => handleInAppStep(deps, step, callId, admitted.fields, inAppCallsEnabled()))
        : { step: step === 'app-status' ? null : ({ verb: 'hangup' } as const) };
      if (!result.step) return reply.code(204).send();
      const out = admitted.provider.render(result.step);
      return reply.type(out.contentType).send(out.body);
    });
  }
}
