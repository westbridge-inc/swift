import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [FIXES-4] A log line never carries a position. Logs are now kept for 30 days
// across a recreate (deploy/keep-logs.py), and where a person was belongs in
// the record that holds it (an SOS alert, an order), never in a log. The kept
// copy is scrubbed as well; this keeps the source clean, so the scrub stays
// the second lock. ride-sos.test.ts proves the responders still get the position.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
  return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
});
const LOG_CALL = /\b(?:log\(\)|log|logger|ctx\.log|request\.log|req\.log|app\.log)\s*\.\s*(?:trace|debug|info|warn|error|fatal)\(\s*\{[^}]*\}/g;
const LOCATION_FIELD = /(?:^|[{,\s])(?:[A-Za-z]*(?:[Ll]at|[Ll]ng)|[Ll]atitude|[Ll]ongitude)\s*[:,}]/;

describe('[FIXES-4] no log line carries a position', () => {
  it('finds log calls at all', () => {
    const text = readFileSync(join(SRC, 'middleware', 'error-handler.ts'), 'utf8');
    expect(text.match(LOG_CALL)?.length).toBeGreaterThan(0);
    expect('log().error({ orderId, lat: body.lat }, "x")'.match(LOG_CALL)?.[0]).toMatch(LOCATION_FIELD);
    expect('ctx.log.warn({ a: 1, deliveryLng }, "x")'.match(LOG_CALL)?.[0]).toMatch(LOCATION_FIELD);
  });

  it('none in the API source names a latitude or a longitude', () => {
    const hits = files(SRC).flatMap((path) => {
      const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      return (code.match(LOG_CALL) ?? []).filter((call) => LOCATION_FIELD.test(call)).map((call) => `${relative(SRC, path)}: ${call.slice(0, 120)}`);
    });
    expect(hits).toEqual([]);
  });
});
