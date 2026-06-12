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
  sendPush(deviceTokens: string[], title: string, body: string, data?: Record<string, unknown>): Promise<{ sent: number }>;
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

/** Provider selection is config, not code. */
export function getChannels(): NotificationChannels {
  const provider = process.env['NOTIFICATION_PROVIDER'] ?? 'dev';
  switch (provider) {
    case 'dev':
      return devChannels;
    default:
      throw new Error(`Unknown NOTIFICATION_PROVIDER: ${provider}`);
  }
}
