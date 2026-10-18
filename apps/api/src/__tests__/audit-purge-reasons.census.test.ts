import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [AUD-G7-043] An audit purge refuses a reason under eight characters
// (lib/audit-immutability.ts). A suite teardown that passes a shorter literal
// reason never cleans anything — and with `.catch(() => 0)` it never says so.
// Census over every API test file: no purge call names a reason that the
// guard is certain to refuse.
const MIN_REASON = 8;
const ROOT = join(__dirname);

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : testFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('[AUD-G7-043] audit purges in tests name a reason the guard accepts', () => {
  it('no test passes a literal purge reason shorter than eight characters (except the refusal tests)', () => {
    const call = /purge(?:AuditLogs|SensitiveReadLogs)\([^;]*?,\s*'([^']*)'\s*\)/g;
    const short: string[] = [];
    let seen = 0;
    for (const file of testFiles(ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(call)) {
        seen += 1;
        // A refusal test asserts the rejection itself.
        const tail = source.slice(match.index! + match[0].length, match.index! + match[0].length + 40);
        if (/^\)?\.rejects/.test(tail.trimStart()) || /rejects/.test(source.slice(Math.max(0, match.index! - 20), match.index!))) continue;
        if (match[1]!.trim().length < MIN_REASON) short.push(`${file.slice(ROOT.length + 1)}: '${match[1]}'`);
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(short).toEqual([]);
  });
});
