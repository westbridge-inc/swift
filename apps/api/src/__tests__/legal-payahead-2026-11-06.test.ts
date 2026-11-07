// [2026-11-06 · PAYAHEAD-4W · owner ruling 6 Nov 2026 "one month at a time" (replaces owner #62) · DRAFT until a Guyana
// attorney reads it] Partners may pay the weekly fee up to four weeks ahead. What the served words must say, read from
// the code that applies it, and who is asked to tick again (partners only: the customer's texts changed by date alone).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserRole } from '@prisma/client';
import { DRIVER_AGREEMENT, LEGAL_VERSION, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, NON_MATERIAL_CHANGES, acceptanceStatus, materialVersion, partnerMaterialVersion } from '../modules/legal/reaccept';
import { PAY_AHEAD_MAX_WEEKS, PAY_AHEAD_MAX_WEEKS_WORD } from '../modules/billing/pay-ahead';
import { weeklyFeeTerms } from '../modules/partner/weekly-fee-ack';

const ROOT = resolve(__dirname, '../../../..');
const REFUNDS = readFileSync(resolve(ROOT, 'apps/web/src/app/legal/refunds/page.tsx'), 'utf8').replace(/\s+/g, ' ');
const feeParagraph = (doc: string) => /<p>You pay Swift a flat weekly subscription[\s\S]*?<\/p>/.exec(doc)?.[0] ?? '';
const SUMMARY = MATERIAL_CHANGES.find((c) => c.version === '2026-11-06')!;

describe('[owner 6 Nov] the four weeks in the words are the four weeks in the code', () => {
  it('the limit is four weeks, one constant', () => {
    expect([PAY_AHEAD_MAX_WEEKS, PAY_AHEAD_MAX_WEEKS_WORD]).toEqual([4, 'four']);
  });

  it.each([['Mover', DRIVER_AGREEMENT], ['Business', VENDOR_AGREEMENT]])('%s Agreement section 2 says up to four weeks, the refund at closing, and the price rules', (_name, doc) => {
    const fee = feeParagraph(doc);
    expect(fee).toContain(`You may pay the weekly fee up to ${PAY_AHEAD_MAX_WEEKS_WORD} weeks ahead: while a week runs you may pay for the ${PAY_AHEAD_MAX_WEEKS_WORD} weeks after it, and no further. Money received beyond that is returned to you.`);
    expect(fee).toContain('If you close your account, Swift refunds to you any weekly fee you paid for a week that has not started');
    expect(fee).toContain('A week you paid for before we told you keeps the old fee');
    expect(fee).toContain('the lower fee applies from your next weekly fee not yet charged, even one you have already paid for');
    expect(fee).not.toMatch(/one week at a time|the coming week, and no further|wallet|top.?up|balance/i);
  });

  it('the refunds page says the same, and what stopping a plan does to weeks already paid', () => {
    expect(REFUNDS).toContain("const UPDATED = '6 November 2026';");
    expect(REFUNDS).toContain('<b>Up to four weeks ahead.</b> You can pay the fee for one week, or up to four weeks ahead: while a week runs you can pay for the four weeks after it, and no further.');
    expect(REFUNDS).toContain('Weeks you paid for that have not started are not used while your plan is stopped: they pay your fee if you start again, or are refunded when you close your account.');
    expect(REFUNDS).not.toMatch(/One week at a time/);
  });

  it('the weekly fee tick (v4) says it too', () => {
    const how = weeklyFeeTerms().items.find((i) => i.heading === 'How you pay')!.text;
    expect(weeklyFeeTerms().version).toBe('v4');
    expect(how).toContain(`for one week or up to ${PAY_AHEAD_MAX_WEEKS_WORD} weeks ahead`);
  });
});

describe('classification: material for partners, and only partners are asked', () => {
  it('2026-11-06 is served, material once, for partners only; the version everyone answers to stays 2026-11-05', () => {
    expect(LEGAL_VERSION).toBe('2026-11-06');
    expect(MATERIAL_CHANGES.filter((c) => c.version === '2026-11-06')).toHaveLength(1);
    expect(SUMMARY.audience).toBe('partner');
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-11-06');
    expect(materialVersion(LEGAL_VERSION)).toBe('2026-11-05');
    expect(partnerMaterialVersion(LEGAL_VERSION)).toBe('2026-11-06');
    expect(partnerMaterialVersion('2026-11-05')).toBeNull();
  });

  it('a customer at 2026-11-05 is not asked; a customer further back sees no partner lines', () => {
    expect(acceptanceStatus({ tosVersion: '2026-11-05', roles: ['CUSTOMER'] as UserRole[] })).toMatchObject({ needsAcceptance: false, summary: [] });
    const behind = acceptanceStatus({ tosVersion: '2026-11-04', roles: ['CUSTOMER'] as UserRole[] });
    expect(behind.needsAcceptance).toBe(true);
    expect(behind.summary).toEqual(MATERIAL_CHANGES.find((c) => c.version === '2026-11-05')!.summary);
  });

  it.each([
    ['a rider', ['MOVER', 'CUSTOMER']], ['a legacy driver', ['DRIVER']], ['a store owner', ['VENDOR_OWNER', 'CUSTOMER']],
  ] as const)('%s at 2026-11-05 is asked, with the four-week summary; at 2026-11-06 is not', (_who, roles) => {
    const at1105 = acceptanceStatus({ tosVersion: '2026-11-05', roles: [...roles] as UserRole[] });
    expect(at1105).toMatchObject({ needsAcceptance: true, summary: SUMMARY.summary });
    expect(acceptanceStatus({ tosVersion: '2026-11-06', roles: [...roles] as UserRole[] })).toMatchObject({ needsAcceptance: false, summary: [] });
    // Further back: every material change since, the partner's own included, oldest first.
    const at1104 = acceptanceStatus({ tosVersion: '2026-11-04', roles: [...roles] as UserRole[] });
    expect(at1104.summary).toEqual([...MATERIAL_CHANGES.find((c) => c.version === '2026-11-05')!.summary, ...SUMMARY.summary]);
  });

  it('a pro (a provider profile, no partner role) is asked too', () => {
    const pro = acceptanceStatus({ tosVersion: '2026-11-05', roles: ['CUSTOMER'] as UserRole[], pro: { acceptedVersion: '2026-11-05' } });
    expect(pro).toMatchObject({ needsAcceptance: true, summary: SUMMARY.summary });
  });

  it('the summary names the limit from the code, and no stored-money words', () => {
    const words = SUMMARY.summary.join(' ');
    expect(words).toContain(`up to ${PAY_AHEAD_MAX_WEEKS_WORD} weeks ahead`);
    expect(words).toContain('every week you paid for that has not started is refunded');
    expect(words).not.toMatch(/wallet|top.?up|balance|banked|stored value|paid ahead/i);
  });
});
