// ---------------------------------------------------------------------------
// Notification channels — hard rule 4: swappable interfaces. Twilio/FCM/SES
// class adapters slot in later; nothing outside this module knows which
// provider exists. The dev adapter logs everything locally and keeps an
// inspectable buffer so tests can assert exactly what would have been sent.
// ---------------------------------------------------------------------------

import { isProduction } from '../../utils/runtime-mode';

export interface SmsProvider {
  sendSms(to: string, body: string): Promise<{ ref: string }>;
}

/** Hard cap on an outbound SMS call — a hung provider must never hang the
 *  login request that is awaiting it. */
const SMS_TIMEOUT_MS = 8000;

/** Per-request cap for Expo/APNs/FCM relay calls. Keep this below durable
 * outbox leases so a dead provider cannot pin dispatch-worker concurrency. */
const pushProviderTimeoutMs = () => {
  const configured = Number(process.env['PUSH_PROVIDER_TIMEOUT_MS']);
  return Number.isFinite(configured) && configured > 0 ? configured : 8_000;
};

export interface PushProvider {
  /** `invalidTokens` = tokens the provider says are dead (app uninstalled) —
   *  the caller deactivates them so we stop pushing at ghosts. */
  sendPush(
    deviceTokens: string[],
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<{ sent: number; invalidTokens?: string[] }>;
}

export interface EmailProvider {
  sendEmail(to: string, subject: string, body: string): Promise<{ ref: string }>;
}

export interface NotificationChannels {
  sms: SmsProvider;
  push: PushProvider;
  email: EmailProvider;
}

export interface DevChannelEntry {
  channel: 'sms' | 'push' | 'email';
  to: string;
  title?: string;
  body: string;
  data?: Record<string, unknown>;
  at: Date;
}

/** Everything the dev adapter "sent", newest last. Tests read and reset this. */
export const devChannelLog: DevChannelEntry[] = [];

export function resetDevChannelLog() {
  devChannelLog.length = 0;
}

let seq = 0;

class DevSms implements SmsProvider {
  async sendSms(to: string, body: string) {
    devChannelLog.push({ channel: 'sms', to, body, at: new Date() });
    return { ref: `dev_sms_${++seq}` };
  }
}

class DevPush implements PushProvider {
  async sendPush(deviceTokens: string[], title: string, body: string, data?: Record<string, unknown>) {
    for (const token of deviceTokens) {
      devChannelLog.push({ channel: 'push', to: token, title, body, data, at: new Date() });
    }
    return { sent: deviceTokens.length };
  }
}

class DevEmail implements EmailProvider {
  async sendEmail(to: string, subject: string, body: string) {
    // THE SAME REFUSAL DevPush CARRIES, FOR THE SAME REASON — and this was the
    // more dangerous omission, because DevEmail was reachable in production by
    // DESIGN rather than by oversight: `getChannels()` returned it from BOTH
    // branches, the 'twilio' production branch included. There is no SES /
    // Postmark / Resend adapter in the tree, so every email Swift believed it
    // sent in production was appended to an in-memory array, handed back a
    // `dev_email_N` reference, and discarded — reporting success every time.
    //
    // IT LIVES ON THE SEND, NOT THE CONSTRUCTOR, and the distinction is the
    // whole design: the hazard is DISCARDING A MESSAGE, and nothing is
    // discarded by this object merely existing. A constructor refusal was
    // tried first and was wrong — it broke two socket-readiness tests that
    // legitimately build a server under NODE_ENV=production to exercise the
    // production adapter path and never send an email at all. A guard that
    // fires on construction punishes code for being near the hazard; a guard
    // on the send fires exactly when the lie would be told.
    //
    // The failure this converts is the one the proof standard calls the silent
    // no-op: a complete code path that returns early, successfully, forever.
    if (isProduction()) {
      throw new Error(
        'FATAL: email has no production provider — DevEmail discards every message while reporting success. ' +
          'Nothing that depends on email (receipts, expiry warnings, help@) would arrive, and nothing would say so. ' +
          'Implement a real EmailProvider and return it from getChannels() before running in production.',
      );
    }
    devChannelLog.push({ channel: 'email', to, title: subject, body, at: new Date() });
    return { ref: `dev_email_${++seq}` };
  }
}

const devChannels: NotificationChannels = {
  sms: new DevSms(),
  push: new DevPush(),
  email: new DevEmail(),
};

/**
 * Twilio SMS adapter (OTP + alerts). Dependency-free: posts to Twilio's REST API
 * with Node's global fetch. Credentials are env-only (hard rule: no secrets in code).
 */
class TwilioSmsProvider implements SmsProvider {
  private sid = process.env['TWILIO_ACCOUNT_SID'] ?? '';
  private token = process.env['TWILIO_AUTH_TOKEN'] ?? '';
  private from = process.env['TWILIO_FROM'] ?? '';

  constructor() {
    if (!this.sid || !this.token || !this.from) {
      throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are required for the twilio provider');
    }
  }

  async sendSms(to: string, body: string): Promise<{ ref: string }> {
    const auth = Buffer.from(`${this.sid}:${this.token}`).toString('base64');
    // Bound the call: a hung Twilio must not hang the login request behind it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: this.from, Body: body }).toString(),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`Twilio SMS request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Twilio SMS failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { sid?: string };
    return { ref: data.sid ?? 'twilio_unknown' };
  }
}

/**
 * Expo Push adapter — one API for both stores (Expo relays to APNs/FCM using
 * the push credentials attached to the EAS build; the server itself needs NO
 * key). Dependency-free like the Twilio adapter: chunked POSTs to exp.host
 * with global fetch. Tokens Expo reports as DeviceNotRegistered come back as
 * `invalidTokens` for deactivation.
 */
export class ExpoPushProvider implements PushProvider {
  private static CHUNK = 100; // Expo's documented max messages per request
  private url = process.env['EXPO_PUSH_URL'] ?? 'https://exp.host/--/api/v2/push/send';

  async sendPush(deviceTokens: string[], title: string, body: string, data?: Record<string, unknown>) {
    let sent = 0;
    const invalidTokens: string[] = [];

    for (let i = 0; i < deviceTokens.length; i += ExpoPushProvider.CHUNK) {
      const chunk = deviceTokens.slice(i, i + ExpoPushProvider.CHUNK);
      const controller = new AbortController();
      const timeoutMs = pushProviderTimeoutMs();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(chunk.map((to) => ({ to, title, body, data, sound: 'default' }))),
          signal: controller.signal,
        });
      } catch (error) {
        const reason = controller.signal.aborted
          ? `timed out after ${timeoutMs}ms`
          : (error as Error).message;
        throw new Error(`Expo push request failed: ${reason}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Expo push failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      // Tickets come back in message order — index maps ticket -> token.
      const payload = (await res.json()) as {
        data?: Array<{ status: 'ok' | 'error'; details?: { error?: string } }>;
      };
      (payload.data ?? []).forEach((ticket, idx) => {
        if (ticket.status === 'ok') {
          sent += 1;
        } else if (ticket.details?.error === 'DeviceNotRegistered') {
          const token = chunk[idx];
          if (token) invalidTokens.push(token);
        }
      });
    }

    return { sent, ...(invalidTokens.length ? { invalidTokens } : {}) };
  }
}

/** Push selection is orthogonal to SMS (PUSH_PROVIDER=dev | expo). */
export function getPushProvider(): PushProvider {
  const provider = process.env['PUSH_PROVIDER'] ?? 'dev';
  switch (provider) {
    case 'dev':
      // [F-027-15] The boot guard for this lives in assertSafeBootConfig, and
      // assertSafeBootConfig is called by exactly two entry points — the
      // server and the worker. The repo also ships a production-targeted
      // cutover script that constructs Fastify and AuthService directly, so it
      // selected DevPush in production with nothing to stop it, and any future
      // script would have done the same. A guard you have to remember to call
      // is a guard that eventually is not called.
      //
      // So the refusal also lives HERE, at the hazard itself: DevPush drops
      // every notification on the floor while reporting success, which is the
      // worst possible production behaviour for dispatch offers and safety
      // pings. No construction path can reach it in production, now or later.
      if (isProduction()) {
        throw new Error('FATAL: PUSH_PROVIDER is dev (in-memory) in production — every push would be silently swallowed while reporting success. Set PUSH_PROVIDER=expo.');
      }
      return new DevPush();
    case 'expo':
      return new ExpoPushProvider();
    default:
      throw new Error(`Unknown PUSH_PROVIDER: ${provider}`);
  }
}

/** Bounded in-process retry for push delivery [SWIFT-UG-NOTIF-01]. Push is
 *  ephemeral (seconds-relevant), so a restart-surviving retry queue would be
 *  over-engineering — but one transient FCM/Expo blip silently eating a
 *  notification is not acceptable either. Two backed-off retries, then the
 *  caller's fire-and-caught owns the final failure. CRITICAL alerts have
 *  their own guarantee regardless: the vendor-alert escalation ladder
 *  re-alerts and falls back to SMS. Delays are injectable for tests. */
export const PUSH_RETRY_DELAYS_MS = [2_000, 8_000];
export function withPushRetry(inner: PushProvider, delays: number[] = PUSH_RETRY_DELAYS_MS): PushProvider & { inner: PushProvider } {
  return {
    /** The wrapped provider — lets composition tests assert WHICH provider
     *  config selected without unwrapping behavior. */
    inner,
    async sendPush(deviceTokens, title, body, data) {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        try {
          return await inner.sendPush(deviceTokens, title, body, data);
        } catch (err) {
          lastErr = err;
          const delay = delays[attempt];
          if (delay == null) break;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw lastErr;
    },
  };
}

/** Provider selection is config, not code. */
export function getChannels(): NotificationChannels {
  const provider = process.env['NOTIFICATION_PROVIDER'] ?? 'dev';
  switch (provider) {
    case 'dev':
      return { sms: devChannels.sms, push: withPushRetry(getPushProvider()), email: devChannels.email };
    case 'twilio':
      return { sms: new TwilioSmsProvider(), push: withPushRetry(getPushProvider()), email: new DevEmail() };
    default:
      throw new Error(`Unknown NOTIFICATION_PROVIDER: ${provider}`);
  }
}
