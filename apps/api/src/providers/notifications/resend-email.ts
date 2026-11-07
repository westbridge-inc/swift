/**
 * Resend email adapter — Swift's email over HTTPS (EMAIL_PROVIDER=resend).
 *
 * [EMAIL-HTTPS 27 Oct 2026] The droplets cannot reach any SMTP server: the
 * hosting provider blocks outbound SMTP, while HTTPS leaves. So the launch
 * sender is Resend's email API, called over HTTPS; the GoDaddy SMTP adapter
 * (smtp-email.ts) stays supported and unchanged.
 *
 * Every fact about Resend here is from Resend's own documentation:
 *   - POST https://api.resend.com/emails, `Authorization: Bearer <API key>`,
 *     `Content-Type: application/json`; body `from`, `to`, `subject`, `text`;
 *     the answer to a sent email is `{ "id": "<uuid>" }`
 *     (resend.com/docs/api-reference/emails/send-email);
 *   - the API is HTTPS only, a request without a `User-Agent` header is refused
 *     with 403, 200 means the request succeeded, 4xx/5xx are errors
 *     (resend.com/docs/api-reference/introduction);
 *   - every error status and name (resend.com/docs/api-reference/errors).
 *
 * Same shape and rules as the SMTP adapter: env-only credentials (the API key
 * arrives as RESEND_API_KEY_FILE from the encrypted store), a loud
 * construction error when the configuration is incomplete (boot-config.ts
 * runs the same reader, so a half-configured sender fails at boot), one
 * attempt with a whole-request deadline, and an honest answer: only a 2xx
 * with an email id is "sent"; anything else throws, so every caller's existing
 * "not sent" handling is unchanged. No retry here: a caller that retries does
 * so on its own schedule. Plain-text messages only, as with SMTP.
 *
 * Personal data: a thrown error names the HTTP status and Resend's error NAME
 * only (a fixed word such as `validation_error`), never Resend's message text,
 * which can repeat an address or a domain. Nothing here logs, and nothing it
 * throws carries the API key, a recipient address, a subject or a message body.
 */
import { isProduction } from '../../utils/runtime-mode';
import type { EmailProvider } from './channels';

/** The one endpoint (Resend's docs). Never read from the environment. */
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 8_000;
/** An error answer is small; a larger one is not read past this. */
const MAX_ANSWER_BYTES = 16 * 1024;
/** `Name <addr@domain>` or `addr@domain`: a sender Resend can take (send-email: "Sender email address"). */
const FROM = /^(?:[^<>@\r\n]*<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>|([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+))$/;

export interface ResendConfig {
  apiKey: string;
  from: string;
  timeoutMs: number;
  /** RESEND_EMAILS_URL in every deployed process; a test hands its own fake endpoint here. */
  url: string;
}

export function resendConfigFromEnv(env: Record<string, string | undefined> = process.env): ResendConfig {
  const apiKey = env['RESEND_API_KEY'] ?? '';
  const from = (env['EMAIL_FROM'] ?? '').trim();
  // Blank is missing, as for SMTP: a key or a sender of only spaces sends nothing.
  const missing = [!apiKey.trim() && 'RESEND_API_KEY', !from && 'EMAIL_FROM'].filter(Boolean);
  if (missing.length) throw new Error(`EMAIL_PROVIDER=resend needs ${missing.join(', ')}`);
  if (!FROM.test(from)) throw new Error('EMAIL_FROM must be an email address (Name <address> or address) on the domain verified with Resend');
  const timeoutMs = Number(env['RESEND_TIMEOUT_MS'] ?? '');
  return { apiKey: apiKey.trim(), from, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS, url: RESEND_EMAILS_URL };
}

/** Resend's error names are fixed lowercase words; anything else is not repeated. */
const errorName = (answer: unknown): string | null => {
  const name = (answer as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[a-z_]{1,64}$/.test(name) ? name : null;
};

/** Read at most MAX_ANSWER_BYTES of the answer, inside the same deadline. */
async function readAnswer(res: Response): Promise<unknown> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) { await reader.cancel().catch(() => undefined); throw new Error(`Resend email answer over ${MAX_ANSWER_BYTES} bytes (HTTP ${res.status})`); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

export class ResendEmailProvider implements EmailProvider {
  private readonly cfg: ResendConfig;
  constructor(cfg: ResendConfig = resendConfigFromEnv()) {
    // The key never crosses the wire in clear, wherever the process runs.
    if (!cfg.url.startsWith('https://')) throw new Error('the Resend endpoint must be https');
    if (isProduction() && cfg.url !== RESEND_EMAILS_URL) throw new Error('production sends email only to Resend\'s own endpoint');
    this.cfg = cfg;
  }

  async sendEmail(to: string, subject: string, body: string): Promise<{ ref: string }> {
    const { cfg } = this;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'swift-api',
        },
        body: JSON.stringify({ from: cfg.from, to: [to], subject, text: body }),
        redirect: 'manual',
        signal: controller.signal,
      });
      const answer = await readAnswer(res);
      if (res.status < 200 || res.status > 299) {
        const name = errorName(answer);
        throw new Error(`Resend email not sent: HTTP ${res.status}${name ? ` ${name}` : ''}`);
      }
      const id = (answer as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error(`Resend email not confirmed: HTTP ${res.status} without an email id`);
      return { ref: id };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Resend email timed out after ${cfg.timeoutMs} ms`);
      if (error instanceof Error && /^Resend email /.test(error.message)) throw error;
      // A network failure: its code only (ECONNREFUSED, a TLS refusal), never a URL or a header.
      const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      throw new Error(`Resend email not sent: request failed${typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? ` (${code})` : ''}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
