/**
 * SMTP email adapter — the launch sender is the founder's GoDaddy mailbox
 * (Professional Email by Titan: smtp.titan.email:465 implicit TLS or 587
 * STARTTLS; Microsoft 365: smtp.office365.com:587 STARTTLS). Dependency-free on purpose:
 * the worktrees share one pnpm store and cannot add packages, and SMTP is a
 * line protocol Node's tls/net speak natively. Plain-text messages only —
 * receipts, expiry warnings, DSAR exports, help@ — nothing that needs HTML.
 *
 * Hard rule 11: env-only credentials, an 8 s cap on the whole dialogue, and a
 * loud construction error when the config is incomplete (a half-configured
 * sender must fail at boot, not at the first receipt). `SMTP_TLS=none` is
 * refused in production: a password never crosses the wire in clear.
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { isProduction } from '../../utils/runtime-mode';
import type { EmailProvider } from './channels';

export interface SmtpConfig {
  host: string;
  port: number;
  /** implicit = TLS from the first byte (465); starttls = upgrade after EHLO (587); none = clear (dev only). */
  tls: 'implicit' | 'starttls' | 'none';
  user: string;
  pass: string;
  from: string;
  timeoutMs: number;
}

export function smtpConfigFromEnv(env: Record<string, string | undefined> = process.env): SmtpConfig {
  const host = env['SMTP_HOST'] ?? '';
  const port = Number(env['SMTP_PORT'] ?? '');
  const user = env['SMTP_USER'] ?? '';
  const pass = env['SMTP_PASS'] ?? '';
  const from = env['EMAIL_FROM'] ?? '';
  const mode = (env['SMTP_TLS'] ?? (port === 465 ? 'implicit' : 'starttls')) as SmtpConfig['tls'];
  const missing = [!host && 'SMTP_HOST', !Number.isInteger(port) && 'SMTP_PORT', !user && 'SMTP_USER', !pass && 'SMTP_PASS', !from && 'EMAIL_FROM'].filter(Boolean);
  if (missing.length) throw new Error(`EMAIL_PROVIDER=smtp needs ${missing.join(', ')}`);
  if (!['implicit', 'starttls', 'none'].includes(mode)) throw new Error(`SMTP_TLS must be implicit, starttls or none (got ${mode})`);
  if (mode === 'none' && isProduction(env)) throw new Error('SMTP_TLS=none is refused in production — the mailbox password would cross the wire in clear');
  const timeoutMs = Number(env['SMTP_TIMEOUT_MS'] ?? '');
  return { host, port, tls: mode, user, pass, from, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8_000 };
}

/** RFC 5321 §4.5.2: a line starting with "." in the body is sent as ".." */
export function dotStuff(body: string): string {
  return body.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
}

/** Non-ASCII subjects travel as RFC 2047 encoded words. */
export function encodeHeaderWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function buildMessage(input: { from: string; to: string; subject: string; body: string; messageId: string; date?: Date }): string {
  const date = (input.date ?? new Date()).toUTCString();
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    `Date: ${date}`,
    `Message-ID: <${input.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${dotStuff(input.body)}\r\n.`;
}

class SmtpDialogue {
  private buffer = '';
  private waiters: Array<{ resolve: (line: string[]) => void; reject: (e: Error) => void }> = [];
  private pending: string[] = [];
  private closed: Error | null = null;
  constructor(private socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }
  rebind(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }
  private fail(e: Error) {
    if (this.closed) return;
    this.closed = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }
  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx); this.buffer = this.buffer.slice(idx + 2);
      this.pending.push(line);
      // a reply is complete when its last line reads "NNN " (space), not "NNN-"
      if (/^\d{3}( |$)/.test(line)) {
        const reply = this.pending.splice(0);
        const w = this.waiters.shift();
        if (w) w.resolve(reply);
      }
    }
  }
  /** Wait for the next complete reply; `expect` = the accepted status class (2xx / 3xx). */
  reply(expect: RegExp, what: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const pick = (lines: string[]) => {
        const code = lines[lines.length - 1]?.slice(0, 3) ?? '';
        if (expect.test(code)) resolve(lines);
        else reject(new Error(`SMTP ${what} refused: ${lines.join(' | ')}`));
      };
      if (this.closed) return reject(this.closed);
      this.waiters.push({ resolve: pick, reject });
    });
  }
  send(line: string) { this.socket.write(`${line}\r\n`); }
  async command(line: string, expect: RegExp, what: string) { this.send(line); return this.reply(expect, what); }
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly cfg: SmtpConfig;
  constructor(cfg: SmtpConfig = smtpConfigFromEnv()) { this.cfg = cfg; }

  async sendEmail(to: string, subject: string, body: string): Promise<{ ref: string }> {
    const { cfg } = this;
    const messageId = `${randomBytes(12).toString('hex')}@${cfg.from.split('@')[1]?.replace(/>$/, '') ?? 'swift'}`;
    const message = buildMessage({ from: cfg.from, to, subject, body, messageId });
    let socket: net.Socket = cfg.tls === 'implicit'
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    const dialogue = new SmtpDialogue(socket);
    const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`SMTP timed out after ${cfg.timeoutMs} ms`)), cfg.timeoutMs).unref());
    const run = async () => {
      await dialogue.reply(/^2/, 'greeting');
      let ehlo = await dialogue.command(`EHLO swift`, /^2/, 'EHLO');
      if (cfg.tls === 'starttls') {
        if (!ehlo.some((l) => /STARTTLS/i.test(l))) throw new Error('SMTP server offers no STARTTLS');
        await dialogue.command('STARTTLS', /^2/, 'STARTTLS');
        socket = tls.connect({ socket, servername: cfg.host });
        dialogue.rebind(socket);
        await new Promise<void>((resolve, reject) => { (socket as tls.TLSSocket).once('secureConnect', () => resolve()); socket.once('error', reject); });
        ehlo = await dialogue.command('EHLO swift', /^2/, 'EHLO after STARTTLS');
      }
      // AUTH PLAIN where offered, AUTH LOGIN otherwise (Microsoft 365 offers LOGIN).
      const auth = ehlo.find((l) => /^250[- ]AUTH/i.test(l)) ?? '';
      if (/PLAIN/i.test(auth)) {
        await dialogue.command(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64')}`, /^2/, 'AUTH');
      } else {
        await dialogue.command('AUTH LOGIN', /^3/, 'AUTH LOGIN');
        await dialogue.command(Buffer.from(cfg.user).toString('base64'), /^3/, 'AUTH LOGIN user');
        await dialogue.command(Buffer.from(cfg.pass).toString('base64'), /^2/, 'AUTH LOGIN password');
      }
      const fromAddr = /<([^>]+)>/.exec(cfg.from)?.[1] ?? cfg.from;
      await dialogue.command(`MAIL FROM:<${fromAddr}>`, /^2/, 'MAIL FROM');
      await dialogue.command(`RCPT TO:<${to}>`, /^2/, 'RCPT TO');
      await dialogue.command('DATA', /^3/, 'DATA');
      await dialogue.command(message, /^2/, 'message');
      // The message is accepted; a QUIT the server never answers must not fail the send.
      await dialogue.command('QUIT', /^2/, 'QUIT').catch(() => undefined);
      return { ref: messageId };
    };
    try {
      return await Promise.race([run(), deadline]);
    } finally {
      socket.destroy();
    }
  }
}
