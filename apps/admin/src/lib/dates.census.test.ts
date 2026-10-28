import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-4] Every date the console shows is written by lib/dates.ts:
// day first, the month in words, Guyana time — never the browser's locale or
// zone ("trial → 11/10/2026" was 10 Nov or 11 Oct depending on who read it).
// ---------------------------------------------------------------------------

describe('[ADMIN-AUDIT S3-4] the date words', () => {
  // The words must not depend on the zone the console runs in. This machine may itself be in Guyana time,
  // so the suite runs in a zone far from it (Node re-reads TZ on assignment) and puts the original back.
  const zone = process.env['TZ'];
  // Imported only after the switch: the formatters are built at import time.
  let gyCalendarDay: typeof import('./dates').gyCalendarDay;
  let gyDate: typeof import('./dates').gyDate;
  let gyDateTime: typeof import('./dates').gyDateTime;
  let gyLongDate: typeof import('./dates').gyLongDate;
  let gyTime: typeof import('./dates').gyTime;
  let gyTodayYmd: typeof import('./dates').gyTodayYmd;
  beforeAll(async () => {
    process.env['TZ'] = 'Pacific/Honolulu';
    ({ gyCalendarDay, gyDate, gyDateTime, gyLongDate, gyTime, gyTodayYmd } = await import('./dates'));
  });
  afterAll(() => { if (zone === undefined) delete process.env['TZ']; else process.env['TZ'] = zone; });
  it('runs where the browser zone is not Guyana time', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Honolulu');
  });
  it('writes Guyana time, day first, the month in words, whatever the browser zone', () => {
    // 2026-11-10T02:30Z is still 9 Nov in Georgetown (UTC-4).
    expect(gyDate('2026-11-10T02:30:00Z')).toBe('9 Nov 2026');
    expect(gyDateTime('2026-10-27T19:04:00Z')).toBe('27 Oct 2026, 15:04');
    expect(gyTime('2026-10-27T19:04:00Z')).toBe('15:04');
    // January tells Guyana (UTC-4) from New York (UTC-5) and from UTC, whatever zone the test runs in.
    expect(gyDateTime('2027-01-15T03:30:00Z')).toBe('14 Jan 2027, 23:30');
    expect(gyLongDate('2026-10-27T19:04:00Z')).toMatch(/^Tuesday,? 27 October 2026$/); // ICU versions differ on the comma
    expect(gyDateTime(Date.parse('2026-10-27T19:04:00Z'))).toBe('27 Oct 2026, 15:04');
  });
  it('a date stored as a calendar day (UTC midnight, e.g. a typed document expiry) prints that day, not the day before', () => {
    expect(gyDate(new Date('2028-06-30').toISOString())).toBe('30 Jun 2028');
    expect(gyDate('2026-09-09T00:00:00.000Z')).toMatch(/^9 Sept? 2026$/); // en-GB September is "Sept" in newer ICU
    expect(gyDate('2026-09-09T00:00:00.001Z')).toMatch(/^8 Sept? 2026$/);
  });
  it('a calendar day prints the day the server sent, in every zone', () => {
    expect(gyCalendarDay('2026-08-23')).toBe('23 Aug 2026');
    expect(gyCalendarDay('2026-08-23T00:00:00Z')).toBe('—');
  });
  it('today in Guyana as a date-input value: the Guyana day, not the UTC day (REVIEW-F #2155 S4-b)', () => {
    // 01:00Z on 28 Oct is 21:00 on 27 Oct in Georgetown: a promo made that evening starts on the 27th.
    expect(gyTodayYmd(new Date('2026-10-28T01:00:00Z'))).toBe('2026-10-27');
    expect(gyTodayYmd(new Date('2026-10-28T04:00:00Z'))).toBe('2026-10-28');
    expect(gyTodayYmd(new Date('2026-10-28T01:00:00Z'), 30)).toBe('2026-11-26');
    expect(gyTodayYmd(new Date('2026-12-31T12:00:00Z'), 1)).toBe('2027-01-01');
  });
  it('a missing or broken value is an em-dash, never "Invalid Date" or 1970', () => {
    for (const v of [null, undefined, '', 'not a date']) {
      expect(gyDate(v)).toBe('—');
      expect(gyDateTime(v)).toBe('—');
      expect(gyTime(v)).toBe('—');
    }
  });
});

const SRC = join(process.cwd(), 'src');
/** A hit kept on purpose, with its reason. A cut-off ISO string is keyed by what it cuts, so a new one is a new hit. */
const ALLOWED: Record<string, string> = {
  'lib/approvals.ts | slice(0, 10) of row.entityId': 'shortens a record id for a title, not a date',
};
/** [REVIEW-F #2155 S3-1] Options that make toLocaleString write a date or a time, whatever its receiver is called
 *  (`at.toLocaleString(undefined, { dateStyle: 'medium' })` wrote the solo wait in the browser's locale and zone).
 *  A number's toLocaleString (money, counts) carries none of these. */
const DATE_OPTION_KEYS = new Set(['dateStyle', 'timeStyle', 'weekday', 'era', 'year', 'month', 'day', 'hour', 'minute', 'second', 'timeZone', 'timeZoneName', 'hour12', 'hourCycle']);
const literal = (e: ts.Expression | undefined, v: number) => !!e && ts.isNumericLiteral(e) && Number(e.text) === v;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('[ADMIN-AUDIT S3-4] the date census', () => {
  it('no page writes a date itself (toLocaleDateString / toLocaleTimeString / toLocaleString of a date / Intl.DateTimeFormat / a cut-off ISO string)', () => {
    const hits: string[] = [];
    const used = new Set<string>();
    for (const path of files(SRC)) {
      const rel = relative(SRC, path);
      if (rel === 'lib/dates.ts') continue;
      const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        let kind: string | null = null;
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const name = n.expression.name.text;
          if (name === 'toLocaleDateString' || name === 'toLocaleTimeString') kind = name;
          if (name === 'toLocaleString') {
            let recv: ts.Expression = n.expression.expression;
            while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
            if (ts.isNewExpression(recv) && recv.expression.getText(sf) === 'Date') kind = 'new Date().toLocaleString';
            const options = n.arguments[1];
            if (options && ts.isObjectLiteralExpression(options) && options.properties.some((p) => p.name && ts.isIdentifier(p.name) && DATE_OPTION_KEYS.has(p.name.text))) {
              kind = 'toLocaleString with date options';
            }
          }
          // [REVIEW-F #2155 S3-1] "2026-10-28" cut from an ISO string is the UTC day (wrong in Guyana 20:00-23:59) and
          // not in words (store-vat wrote "Certificate sent 2026-10-28" for a certificate sent on the evening of 27 Oct).
          if ((name === 'slice' || name === 'substring' || name === 'substr') && literal(n.arguments[0], 0) && literal(n.arguments[1], 10)) {
            kind = `slice(0, 10) of ${n.expression.expression.getText(sf)}`;
          }
        }
        if (ts.isPropertyAccessExpression(n) && n.getText(sf) === 'Intl.DateTimeFormat') kind = 'Intl.DateTimeFormat';
        if (kind) {
          const key = `${rel} | ${kind}`;
          if (ALLOWED[key]) used.add(key);
          else hits.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${kind}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(hits).toEqual([]);
    expect([...used].sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});
