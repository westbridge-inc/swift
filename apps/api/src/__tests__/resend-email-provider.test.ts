/**
 * [EMAIL-HTTPS 27 Oct 2026] The Resend email adapter against a local fake HTTPS
 * endpoint (node:https, a throwaway self-signed certificate made by openssl for
 * this run). The droplets cannot reach SMTP, so production email leaves over
 * HTTPS to Resend. Asserts the request Resend's docs describe, that only a 2xx
 * with an email id counts as sent, that every other answer, a hang and a TLS
 * refusal THROW (so callers' "not sent" handling is unchanged), one attempt
 * only, and that nothing logged or thrown carries the key, a recipient, a
 * subject or a body.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResendEmailProvider, resendConfigFromEnv, RESEND_EMAILS_URL, type ResendConfig } from '../providers/notifications/resend-email';

const KEY = 're_synthetic_key_for_tests_only_0123456789';
const TO = 'customer.person@example.gy';
const SUBJECT = 'Your Swift receipt for order 4417';
const BODY = 'Private body line: 12 Lamaha Street, Georgetown';
const FROM = 'Swift <no-reply@swiftgy.com>';

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let dir = '';
let tlsKey: Buffer; let tlsCert: Buffer;
const servers: https.Server[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'resend-fake-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  tlsKey = readFileSync(join(dir, 'k.pem')); tlsCert = readFileSync(join(dir, 'c.pem'));
});
afterAll(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** A fake Resend on 127.0.0.1 over HTTPS; every request it receives is recorded. */
async function fake(handler: Handler): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => { seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }); handler(req, res, body); });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/emails`, seen };
}
const json = (status: number, value: unknown): Handler => (_req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const cfg = (url: string, over: Partial<ResendConfig> = {}): ResendConfig => ({ apiKey: KEY, from: FROM, timeoutMs: 2_000, url, ...over });
/** The fake's certificate is self-signed: trusted for these cases only (the TLS case below proves the adapter never turns checking off itself). */
const trustTheFake = () => vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
const failureOf = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected the send to throw'); }, (e: Error) => e);

/** Everything a person could see: console output and the thrown messages. */
function captureConsole(): string[] {
  const out: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  return out;
}
const leaks = (texts: string[]) => texts.filter((t) => [KEY, TO, SUBJECT, BODY, 'Lamaha'].some((secret) => t.includes(secret)));

describe('[EMAIL-HTTPS] TLS checking stays on', () => {
  it('a server whose certificate is not trusted gets no email: the send throws (not sent)', async () => {
    const { url, seen } = await fake(json(200, { id: 'never' }));
    const err = await failureOf(new ResendEmailProvider(cfg(url)).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toMatch(/^Resend email not sent: request failed/);
    expect(seen).toHaveLength(0);
    expect(leaks([err.message, String(err.stack)])).toEqual([]);
  });
});

describe('[EMAIL-HTTPS] the request Resend\'s docs describe', () => {
  it('POST /emails with the Bearer key, JSON, a User-Agent, and from / to / subject / text; the email id comes back', async () => {
    trustTheFake();
    const { url, seen } = await fake(json(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));
    const res = await new ResendEmailProvider(cfg(url)).sendEmail(TO, SUBJECT, BODY);
    expect(res).toEqual({ ref: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/emails');
    expect(seen[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers['content-type']).toBe('application/json');
    expect(seen[0]!.headers['user-agent']).toBe('swift-api');
    expect(JSON.parse(seen[0]!.body)).toEqual({ from: FROM, to: [TO], subject: SUBJECT, text: BODY });
  });
});

describe('[EMAIL-HTTPS] honest failure: only a 2xx with an email id is "sent"', () => {
  it.each([
    [400, 'validation_error'], [401, 'missing_api_key'], [403, 'validation_error'], [422, 'missing_required_field'],
    [429, 'rate_limit_exceeded'], [429, 'daily_quota_exceeded'], [500, 'application_error'], [503, 'service_unavailable'],
  ])('HTTP %i %s throws, after ONE request, naming only the status and Resend\'s error name', async (status, name) => {
    trustTheFake();
    const logs = captureConsole();
    // Resend's message can repeat an address: it must never reach our error.
    const { url, seen } = await fake(json(status, { statusCode: status, name, message: `You can only send testing emails to your own email address (${TO}).` }));
    const err = await failureOf(new ResendEmailProvider(cfg(url)).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toBe(`Resend email not sent: HTTP ${status} ${name}`);
    expect(seen).toHaveLength(1);
    expect(leaks([err.message, String(err.stack), ...logs])).toEqual([]);
  });

  it('an error name that is not one of Resend\'s plain words is not repeated', async () => {
    trustTheFake();
    const { url } = await fake(json(403, { name: `${TO} is blocked` }));
    const err = await failureOf(new ResendEmailProvider(cfg(url)).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toBe('Resend email not sent: HTTP 403');
  });

  it.each([
    ['no id', { ok: true }], ['an empty id', { id: '' }], ['a non-string id', { id: 7 }], ['not JSON', 'sent!'],
  ])('a 200 with %s is not a sent email: it throws', async (_label, value) => {
    trustTheFake();
    const { url } = await fake((_req, res) => { res.writeHead(200); res.end(typeof value === 'string' ? value : JSON.stringify(value)); });
    const err = await failureOf(new ResendEmailProvider(cfg(url)).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toMatch(/^Resend email not confirmed: HTTP 200/);
  });

  it('a redirect is not followed and not a sent email', async () => {
    trustTheFake();
    const { url, seen } = await fake((_req, res) => { res.writeHead(307, { Location: 'https://127.0.0.1:1/elsewhere' }); res.end(); });
    const err = await failureOf(new ResendEmailProvider(cfg(url)).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toBe('Resend email not sent: HTTP 307');
    expect(seen).toHaveLength(1);
  });

  it('an answer larger than an error ever is stops being read and throws', async () => {
    trustTheFake();
    const { url } = await fake((_req, res) => { res.writeHead(500); res.end('x'.repeat(64 * 1024)); });
    const err = await failureOf(new ResendEmailProvider(cfg(url)).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toMatch(/^Resend email answer over 16384 bytes \(HTTP 500\)/);
  });
});

describe('[EMAIL-HTTPS] a deadline on the whole request, no retry', () => {
  it('a server that never answers: the send throws at the deadline, after one request', async () => {
    trustTheFake();
    const { url, seen } = await fake(() => { /* never answers */ });
    const started = Date.now();
    const err = await failureOf(new ResendEmailProvider(cfg(url, { timeoutMs: 300 })).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toBe('Resend email timed out after 300 ms');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen).toHaveLength(1);
  });

  it('headers then a stalled body: still the deadline', async () => {
    trustTheFake();
    const { url } = await fake((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); res.write('{"id":'); });
    const err = await failureOf(new ResendEmailProvider(cfg(url, { timeoutMs: 300 })).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toBe('Resend email timed out after 300 ms');
  });

  it('a refused connection throws with its code only', async () => {
    const err = await failureOf(new ResendEmailProvider(cfg('https://127.0.0.1:1/emails')).sendEmail(TO, SUBJECT, BODY));
    expect(err.message).toMatch(/^Resend email not sent: request failed/);
    expect(err.message).not.toContain('127.0.0.1');
  });
});

describe('[EMAIL-HTTPS] configuration (the same reader boot-config.ts runs)', () => {
  const env = { RESEND_API_KEY: KEY, EMAIL_FROM: FROM };
  it('reads the key and the sender; the endpoint is always Resend\'s own; 8 s by default', () => {
    expect(resendConfigFromEnv(env)).toEqual({ apiKey: KEY, from: FROM, timeoutMs: 8_000, url: RESEND_EMAILS_URL });
    expect(RESEND_EMAILS_URL).toBe('https://api.resend.com/emails');
    expect(resendConfigFromEnv({ ...env, RESEND_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5_000);
    expect(resendConfigFromEnv({ ...env, RESEND_TIMEOUT_MS: 'soon' }).timeoutMs).toBe(8_000);
    expect(resendConfigFromEnv({ ...env, EMAIL_FROM: 'no-reply@swiftgy.com' }).from).toBe('no-reply@swiftgy.com');
  });

  it.each(['RESEND_API_KEY', 'EMAIL_FROM'])('refuses without %s, or with it blank, by name and never echoing the key', (name) => {
    for (const value of [undefined, '', '  ']) {
      let message = '';
      try { resendConfigFromEnv({ ...env, [name]: value }); } catch (e) { message = String(e); }
      expect(message).toMatch(new RegExp(`EMAIL_PROVIDER=resend needs ${name}`));
      expect(message).not.toContain(KEY);
    }
  });

  it.each(['Swift', 'Swift <no-reply>', 'a@b', 'Swift <a@b.com', 'two@x.com, three@y.com'])('refuses a sender that is not one address: %j', (from) => {
    expect(() => resendConfigFromEnv({ ...env, EMAIL_FROM: from })).toThrow(/EMAIL_FROM must be an email address/);
  });

  it('the key never crosses in clear, and production sends only to Resend\'s own endpoint', () => {
    expect(() => new ResendEmailProvider(cfg('http://api.resend.com/emails'))).toThrow(/must be https/);
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new ResendEmailProvider(cfg('https://127.0.0.1:1/emails'))).toThrow(/only to Resend's own endpoint/);
    expect(() => new ResendEmailProvider(cfg(RESEND_EMAILS_URL))).not.toThrow();
  });
});
