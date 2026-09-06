/**
 * The SMTP email adapter against a fake SMTP server (node:net): the launch
 * sender is the founder's GoDaddy mailbox. Asserts the dialogue Microsoft 365 /
 * GoDaddy expect (EHLO, AUTH, envelope, DATA, QUIT), dot-stuffing, the
 * Message-ID the caller gets back, the timeout, and that a clear-text
 * password is refused in production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { SmtpEmailProvider, smtpConfigFromEnv, dotStuff, encodeHeaderWord, buildMessage } from '../providers/notifications/smtp-email';

interface Exchange { lines: string[]; data: string }
let server: net.Server; let port = 0;
const exchanges: Exchange[] = [];
let mode: 'plain' | 'login' | 'refuse-rcpt' | 'hang' = 'plain';

beforeAll(async () => {
  server = net.createServer((sock) => {
    const ex: Exchange = { lines: [], data: '' }; exchanges.push(ex);
    let inData = false; let buf = ''; let authStep = 0;
    const say = (s: string) => sock.write(`${s}\r\n`);
    say('220 fake.smtp ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; say('250 2.0.0 queued as fake-1'); } else ex.data += `${line}\n`;
          continue;
        }
        ex.lines.push(line);
        if (mode === 'hang') continue;
        if (authStep === 1) { authStep = 2; say('334 UGFzc3dvcmQ6'); }
        else if (authStep === 2) { authStep = 3; say('235 ok'); }
        else if (line.startsWith('EHLO')) { sock.write('250-fake.smtp\r\n'); say(mode === 'login' ? '250 AUTH LOGIN' : '250 AUTH PLAIN LOGIN'); }
        else if (line.startsWith('AUTH PLAIN')) say('235 2.7.0 Authentication successful');
        else if (line === 'AUTH LOGIN') { authStep = 1; say('334 VXNlcm5hbWU6'); }
        else if (line.startsWith('MAIL FROM')) say('250 ok');
        else if (line.startsWith('RCPT TO')) say(mode === 'refuse-rcpt' ? '550 5.1.1 no such user' : '250 ok');
        else if (line === 'DATA') { inData = true; say('354 go ahead'); }
        else if (line === 'QUIT') { say('221 bye'); sock.end(); }
        else say('500 what');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const cfg = (over: Partial<ReturnType<typeof smtpConfigFromEnv>> = {}) => ({
  host: '127.0.0.1', port, tls: 'none' as const, user: 'no-reply@swift.gy', pass: 'app-password', from: 'Swift <no-reply@swift.gy>', timeoutMs: 3_000, ...over,
});

describe('SMTP dialogue', () => {
  it('EHLO, AUTH PLAIN, envelope, DATA with dot-stuffing, QUIT — and the caller gets the Message-ID back', async () => {
    mode = 'plain';
    const res = await new SmtpEmailProvider(cfg()).sendEmail('rider@example.gy', 'Your document expires soon', 'Line one\n.starts with a dot\nLast line');
    const ex = exchanges[exchanges.length - 1]!;
    expect(ex.lines[0]).toBe('EHLO swift');
    expect(ex.lines[1]).toBe(`AUTH PLAIN ${Buffer.from('\0no-reply@swift.gy\0app-password').toString('base64')}`);
    expect(ex.lines).toContain('MAIL FROM:<no-reply@swift.gy>');
    expect(ex.lines).toContain('RCPT TO:<rider@example.gy>');
    expect(ex.lines).toContain('DATA');
    expect(ex.lines[ex.lines.length - 1]).toBe('QUIT');
    expect(ex.data).toContain('Subject: Your document expires soon');
    expect(ex.data).toContain('From: Swift <no-reply@swift.gy>');
    expect(ex.data).toContain(`Message-ID: <${res.ref}>`);
    expect(ex.data).toContain('\n..starts with a dot\n');
    expect(res.ref).toMatch(/^[0-9a-f]{24}@swift\.gy$/);
  });

  it('falls back to AUTH LOGIN when the server (Microsoft 365) offers no PLAIN', async () => {
    mode = 'login';
    await new SmtpEmailProvider(cfg()).sendEmail('a@example.gy', 's', 'b');
    const ex = exchanges[exchanges.length - 1]!;
    expect(ex.lines[1]).toBe('AUTH LOGIN');
    expect(ex.lines[2]).toBe(Buffer.from('no-reply@swift.gy').toString('base64'));
    expect(ex.lines[3]).toBe(Buffer.from('app-password').toString('base64'));
  });

  it('a refused recipient is an error that names the step, never a silent success', async () => {
    mode = 'refuse-rcpt';
    await expect(new SmtpEmailProvider(cfg()).sendEmail('nobody@example.gy', 's', 'b')).rejects.toThrow(/RCPT TO refused: 550/);
  });

  it('a hung server is cut by the timeout', async () => {
    mode = 'hang';
    await expect(new SmtpEmailProvider(cfg({ timeoutMs: 300 })).sendEmail('a@example.gy', 's', 'b')).rejects.toThrow(/timed out after 300 ms/);
    mode = 'plain';
  });
});

describe('config', () => {
  const base = { SMTP_HOST: 'smtp.office365.com', SMTP_PORT: '587', SMTP_USER: 'u@x.gy', SMTP_PASS: 'p', EMAIL_FROM: 'Swift <u@x.gy>' };
  it('port 587 defaults to STARTTLS and 465 to implicit TLS', () => {
    expect(smtpConfigFromEnv(base).tls).toBe('starttls');
    expect(smtpConfigFromEnv({ ...base, SMTP_PORT: '465' }).tls).toBe('implicit');
  });
  it('names every missing variable', () => {
    expect(() => smtpConfigFromEnv({ SMTP_PORT: '587' })).toThrow(/SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM/);
  });
  it('SMTP_TLS=none is refused in production', () => {
    expect(() => smtpConfigFromEnv({ ...base, SMTP_TLS: 'none', NODE_ENV: 'production' })).toThrow(/refused in production/);
    expect(smtpConfigFromEnv({ ...base, SMTP_TLS: 'none', NODE_ENV: 'test' }).tls).toBe('none');
  });
});

describe('message assembly', () => {
  it('dot-stuffs, normalises CRLF, encodes a non-ASCII subject, and ends with the terminator', () => {
    expect(dotStuff('a\n.b\r\n..c')).toBe('a\r\n..b\r\n...c');
    expect(encodeHeaderWord('Plain subject')).toBe('Plain subject');
    expect(encodeHeaderWord('Reçu — Swift')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const m = buildMessage({ from: 'a@x', to: 'b@y', subject: 's', body: 'x', messageId: 'id@x', date: new Date(0) });
    expect(m.startsWith('From: a@x\r\nTo: b@y\r\nSubject: s\r\nDate: Thu, 01 Jan 1970 00:00:00 GMT\r\nMessage-ID: <id@x>\r\n')).toBe(true);
    expect(m.endsWith('\r\n\r\nx\r\n.')).toBe(true);
  });
});
