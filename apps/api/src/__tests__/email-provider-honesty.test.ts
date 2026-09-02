import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getChannels } from '../providers/notifications/channels';

/**
 * NO SILENT PROVIDERS — the email half.
 *
 * `getChannels()` returned `DevEmail` from BOTH branches, the production
 * 'twilio' branch included, and there is no SES/Postmark/Resend adapter in the
 * tree. So every email Swift believed it sent in production was appended to an
 * in-memory array, handed back a `dev_email_N` reference, and discarded —
 * reporting success every single time.
 *
 * That is the silent no-op: a complete code path that returns early,
 * successfully, forever. It is the same failure class as the push blocker with
 * one difference that made it worse — push is unreachable by ACCIDENT (a
 * missing build credential); email was reachable by DESIGN.
 *
 * ── WHERE THE GUARD LIVES, AND WHY IT MOVED ────────────────────────────────
 *
 * The first implementation refused in the CONSTRUCTOR and was wrong. It broke
 * `socket-redis-readiness` and `socket-redis-adapter`, which legitimately build
 * a server under NODE_ENV=production to exercise the production socket adapter
 * path — and never send an email at all. They were not misusing anything; the
 * guard was simply in the wrong place.
 *
 * The hazard is DISCARDING A MESSAGE. Nothing is discarded by this object
 * existing. So the refusal belongs on `sendEmail`, which is the exact moment
 * the lie would be told. A guard on construction punishes code for being NEAR
 * the hazard; a guard on the send fires AT it.
 */

const CHANNELS = join(process.cwd(), 'src/providers/notifications/channels.ts');
const source = readFileSync(CHANNELS, 'utf8');

/** Source with comments stripped — the standing hazard-matching rule. The
 *  comments above and in the file necessarily quote what is asserted below. */
const code = source
  .split('\n')
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

const originalEnv = process.env['NODE_ENV'];
afterEach(() => {
  if (originalEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = originalEnv;
});

describe('email refuses production rather than discarding it', () => {
  it('sending in production throws instead of silently succeeding', async () => {
    const email = getChannels().email;
    process.env['NODE_ENV'] = 'production';
    await expect(email.sendEmail('a@example.com', 'subject', 'body')).rejects.toThrow(
      /no production provider/i,
    );
  });

  it('outside production it still sends normally', async () => {
    const email = getChannels().email;
    process.env['NODE_ENV'] = 'development';
    await expect(email.sendEmail('a@example.com', 'subject', 'body')).resolves.toBeTruthy();
  });

  it('the refusal names the consequence, not just the condition', () => {
    // "Email is dev" tells an operator nothing. The message that stops a bad
    // deploy says what silently stopped working.
    expect(code).toMatch(/discards every message while reporting success/);
    expect(code).toMatch(/receipts, expiry warnings/);
  });
});

describe('the guard is on the SEND, not the constructor', () => {
  // This is the regression that matters. A constructor refusal reads as
  // stricter and is actually worse: it breaks any code that builds channels
  // under a production env without ever emailing, which is exactly what two
  // socket-readiness tests do.
  const devEmailBlock = code.split('class DevEmail')[1]?.split('\n}')[0] ?? '';

  it('the block was actually found (guards the guard)', () => {
    expect(devEmailBlock.length).toBeGreaterThan(80);
    expect(devEmailBlock).toMatch(/sendEmail/);
  });

  it('DevEmail declares no constructor', () => {
    expect(devEmailBlock).not.toMatch(/constructor\s*\(/);
  });

  it('the throw sits inside sendEmail', () => {
    const sendBlock = devEmailBlock.split('sendEmail')[1] ?? '';
    // [TA-S1-007] posture comes from the one parser, never the raw string.
    expect(sendBlock).toMatch(/isProduction\(\)/);
    expect(sendBlock).toMatch(/throw new Error/);
  });

  it('merely BUILDING the channels under production does not throw', () => {
    // The literal case that broke: build the object, send nothing.
    //
    // It must be the production-REALISTIC config. Under NODE_ENV=production
    // with the dev provider, getChannels() throws on DevPush's own long-
    // standing refusal — correct, pre-existing, and not what this test is
    // about. (The first version of this assertion missed that and failed for
    // the wrong reason.)
    const prev = {
      provider: process.env['NOTIFICATION_PROVIDER'],
      push: process.env['PUSH_PROVIDER'],
      sid: process.env['TWILIO_ACCOUNT_SID'],
      tok: process.env['TWILIO_AUTH_TOKEN'],
      from: process.env['TWILIO_FROM'],
    };
    try {
      process.env['NOTIFICATION_PROVIDER'] = 'twilio';
      process.env['PUSH_PROVIDER'] = 'expo';
      process.env['TWILIO_ACCOUNT_SID'] = 'AC_test_not_a_real_sid';
      process.env['TWILIO_AUTH_TOKEN'] = 'test_not_a_real_token';
      process.env['TWILIO_FROM'] = '+15550000000';
      process.env['NODE_ENV'] = 'production';
      expect(() => getChannels()).not.toThrow();
    } finally {
      // Assigning `undefined` stores the STRING "undefined" — delete instead.
      restoreEnv('NOTIFICATION_PROVIDER', prev.provider);
      restoreEnv('PUSH_PROVIDER', prev.push);
      restoreEnv('TWILIO_ACCOUNT_SID', prev.sid);
      restoreEnv('TWILIO_AUTH_TOKEN', prev.tok);
      restoreEnv('TWILIO_FROM', prev.from);
    }
  });
});

describe('the production branch still has no real email provider', () => {
  it('getChannels() twilio branch returns DevEmail — the gap is real, and now loud', () => {
    // This does NOT assert the gap is fixed; it asserts it is HONEST. When a
    // real provider lands, this test is the one that must be updated — which is
    // the point: it makes the substitution a deliberate act.
    const factory = code.split('export function getChannels')[1] ?? '';
    expect(factory.length).toBeGreaterThan(50);
    expect(factory).toMatch(/case 'twilio'/);
    expect(factory).toMatch(/email:\s*new DevEmail\(\)/);
  });

  it('no real email adapter exists in the tree yet', () => {
    // If one is added and this fails, delete this test and wire it in.
    expect(code).not.toMatch(/class (Ses|Postmark|Resend|Sendgrid|Mailgun)Email/i);
  });
});

/** Put an env var back exactly as it was — deleting it if it was unset,
 *  because assigning `undefined` stores the string "undefined". */
function restoreEnv(key: string, previous: string | undefined) {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}
