// ---------------------------------------------------------------------------
// Notification channels — hard rule 4: swappable interfaces. Twilio/FCM/SES
// class adapters slot in later; nothing outside this module knows which
// provider exists. The dev adapter logs everything locally and keeps an
// inspectable buffer so tests can assert exactly what would have been sent.
// ---------------------------------------------------------------------------

export interface SmsProvider {
  sendSms(to: string, body: string): Promise<{ ref: string }>;
}

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
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: this.from, Body: body }).toString(),
    });
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
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk.map((to) => ({ to, title, body, data, sound: 'default' }))),
      });
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
      return new DevPush();
    case 'expo':
      return new ExpoPushProvider();
    default:
      throw new Error(`Unknown PUSH_PROVIDER: ${provider}`);
  }
}

/** Provider selection is config, not code. */
export function getChannels(): NotificationChannels {
  const provider = process.env['NOTIFICATION_PROVIDER'] ?? 'dev';
  switch (provider) {
    case 'dev':
      return { sms: devChannels.sms, push: getPushProvider(), email: devChannels.email };
    case 'twilio':
      return { sms: new TwilioSmsProvider(), push: getPushProvider(), email: new DevEmail() };
    default:
      throw new Error(`Unknown NOTIFICATION_PROVIDER: ${provider}`);
  }
}
