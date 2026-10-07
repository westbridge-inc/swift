import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REASON_MIN, REASON_MAX, TEMPLATE_REASONS, MONEY_MAX_WHOLE, REFERENCE_SHAPE,
  checkReason, headerSafe, parseAmountGyd, checkReference,
} from '@/lib/reason-rules';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] THE REASON PANEL'S RULES ARE THE SERVER'S RULES.
//
// The in-page reason panel validates before it sends, so the operator hears
// about a short reason or a malformed reference beside the field — not as a
// refused request. That only helps if the panel's rule IS the server's rule,
// so the server values are read from the API source here, and a change on
// either side without the other fails this file.
// ---------------------------------------------------------------------------

const API_SRC = join(process.cwd(), '..', 'api', 'src');
const authority = readFileSync(join(API_SRC, 'modules', 'admin', 'admin-authority.ts'), 'utf8');
const evidence = readFileSync(join(API_SRC, 'modules', 'money', 'evidence.ts'), 'utf8');
const moneySchema = readFileSync(join(API_SRC, 'utils', 'money-schema.ts'), 'utf8');

describe('[MC-PR1] the panel and the server agree (read from the API source)', () => {
  it('reason length: the server reasonProblem bounds', () => {
    expect(authority).toContain(`export const ADMIN_REASON_MIN = ${REASON_MIN};`);
    expect(authority).toContain(`export const ADMIN_REASON_MAX = ${REASON_MAX};`);
    expect(REASON_MIN).toBe(12);
    expect(REASON_MAX).toBe(500);
  });

  it('the template phrases the server refuses are the same list, in full', () => {
    const block = /const TEMPLATE_REASONS: readonly string\[\] = \[([\s\S]*?)\];/.exec(authority)?.[1];
    expect(block, 'TEMPLATE_REASONS not found in admin-authority.ts').toBeTruthy();
    const serverList = [...block!.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect([...TEMPLATE_REASONS].sort()).toEqual([...serverList].sort());
  });

  it('a money reference has the server evidence shape', () => {
    expect(evidence).toContain(`const REFERENCE_SHAPE = ${REFERENCE_SHAPE.toString()};`);
  });

  it('an amount ceiling matches the server money schema', () => {
    expect(moneySchema).toContain(`export const MONEY_MAX_WHOLE = ${MONEY_MAX_WHOLE.toLocaleString('en-US').replaceAll(',', '_')};`);
  });
});

describe('[MC-PR1] checkReason', () => {
  it('accepts 12 to 500 characters after trimming, and returns the trimmed text', () => {
    expect(checkReason('  ' + 'a'.repeat(12) + '  ')).toEqual({ ok: true, reason: 'a'.repeat(12) });
    expect(checkReason('a'.repeat(500))).toEqual({ ok: true, reason: 'a'.repeat(500) });
  });

  it('refuses empty, short and long reasons with the server’s words', () => {
    expect(checkReason('   ')).toMatchObject({ ok: false, problem: 'missing' });
    expect(checkReason('a'.repeat(11))).toMatchObject({ ok: false, problem: 'too-short', message: expect.stringMatching(/at least 12 characters/) });
    expect(checkReason('a'.repeat(501))).toMatchObject({ ok: false, problem: 'too-long', message: expect.stringMatching(/under 500 characters/) });
  });

  it('refuses a template phrase, whole-reason only, as the server does', () => {
    expect(checkReason('Suspended by admin.')).toMatchObject({ ok: false, problem: 'template' });
    expect(checkReason('Approved by admin!!')).toMatchObject({ ok: false, problem: 'template' });
    expect(checkReason('Suspended by admin, repeated no-shows after three warnings')).toMatchObject({ ok: true });
  });

  it('iPhone smart punctuation is sent as plain punctuation (a header cannot carry ’ “ ” – —)', () => {
    const typed = 'Owner’s “licence” checked – all four pages — in person…';
    const result = checkReason(typed);
    expect(result).toEqual({ ok: true, reason: 'Owner\'s "licence" checked - all four pages - in person...' });
    if (result.ok) expect(headerSafe(result.reason)).toBe(true);
  });

  it('what still cannot travel in a header (emoji, non-Latin scripts) is refused before sending, in plain words', () => {
    expect(checkReason('Owner confirmed by phone 👍 today')).toMatchObject({ ok: false, problem: 'unsendable', message: expect.stringMatching(/emoji/) });
    expect(checkReason('Café owner showed the original licence')).toMatchObject({ ok: true }); // Latin-1 is fine
  });
});

describe('[MC-PR1] amount (GYD) and reference fields', () => {
  it('reads an amount the way people type it, as whole GYD', () => {
    expect(parseAmountGyd('4500')).toEqual({ ok: true, value: 4500 });
    expect(parseAmountGyd(' G$4,500 ')).toEqual({ ok: true, value: 4500 });
    expect(parseAmountGyd('$12,000')).toEqual({ ok: true, value: 12000 });
  });

  it('refuses what is not an amount — never coerces it to 0', () => {
    for (const bad of ['', '   ', 'abc', '4.5.0', '-100', '1e3', '0x10']) {
      expect(parseAmountGyd(bad).ok, bad).toBe(false);
    }
    expect(parseAmountGyd('0')).toMatchObject({ ok: false, message: expect.stringMatching(/more than G\$0/) });
    expect(parseAmountGyd('4500.50')).toMatchObject({ ok: false, message: expect.stringMatching(/whole dollars/) });
    expect(parseAmountGyd('100000000')).toMatchObject({ ok: false });
  });

  it('allows cents only where the caller says the server takes them', () => {
    expect(parseAmountGyd('4500.50', { cents: true })).toEqual({ ok: true, value: 4500.5 });
    expect(parseAmountGyd('4500.505', { cents: true }).ok).toBe(false);
  });

  it('a reference is trimmed and upper-cased like the server, and must have its shape', () => {
    expect(checkReference('  mmg-2026/001 ')).toEqual({ ok: true, value: 'MMG-2026/001' });
    expect(checkReference('')).toMatchObject({ ok: false, message: expect.stringMatching(/Enter/) });
    expect(checkReference('ab')).toMatchObject({ ok: false });
    expect(checkReference('-REF1')).toMatchObject({ ok: false });
    expect(checkReference('REF 1')).toMatchObject({ ok: false });
  });
});
