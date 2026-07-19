import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// D9-07 — pino's redaction list (utils/logger-config.ts) censors sensitive
// values inside logged OBJECTS. It cannot touch a secret that was interpolated
// straight into a log *message* string: `logger.info(`otp is ${otp}`)` bakes
// the secret into the text before pino ever sees a redactable path. This test
// is the tripwire — it fails CI if any source file interpolates a secret-named
// identifier into a logging call, so the redaction guarantee can't be silently
// bypassed by a template literal. (CLAUDE.md rule 4.)
// ---------------------------------------------------------------------------

const SRC_ROOT = path.resolve(__dirname, '..');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// A `${...}` interpolation naming a secret. Word-boundaried so `tokenType` /
// `secretsCount` don't trip it; `code`/`pin` bare are deliberately excluded —
// too many benign error/status codes — the real ride/pickup codes are covered
// by their compound names.
const SECRET =
  /\$\{[^}]*\b(otp|otpCode|token|refreshToken|accessToken|password|passwordHash|secret|mmgPassword|ridePin|pickupCode|deliveryPin|cvc|cardNumber|mkey|msecret)\b[^}]*\}/i;

// A logging call opener (pino instance, request/reply logger, or console).
const LOGCALL =
  /\b(?:log|logger|req\.log|request\.log|reply\.log|app\.log|this\.log|fastify\.log|console)\s*\.\s*(?:info|warn|error|debug|trace|fatal|log)\s*\(/;

describe('log secret-interpolation guard (D9-07)', () => {
  const files = tsFilesUnder(SRC_ROOT);

  it('scans a meaningful slice of the source tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no source file interpolates a secret into a log message', () => {
    const offenders: string[] = [];
    const secretGlobal = new RegExp(SECRET.source, 'gi');

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (!SECRET.test(src)) continue; // fast path — most files have no secret interpolation at all

      let m: RegExpExecArray | null;
      secretGlobal.lastIndex = 0;
      while ((m = secretGlobal.exec(src))) {
        // Is this interpolation an argument to a log call? Look back over the
        // current statement (bounded window since the last statement break) —
        // if a log-call opener sits before it there, the secret is being logged.
        const before = src.slice(Math.max(0, m.index - 240), m.index);
        const stmt = before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1);
        if (LOGCALL.test(stmt)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}: ${m[0].slice(0, 100)}`);
        }
      }
    }

    expect(offenders, `secrets interpolated into log messages (redaction bypass):\n${offenders.join('\n')}`).toEqual([]);
  });
});
