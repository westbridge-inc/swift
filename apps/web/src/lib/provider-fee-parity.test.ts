import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRO_FEE_COVERED_COPY, PRO_FEE_COVERED_TICK_LINE, PRO_FEE_OWN_FEE_LINK, proFeeAgreementFirst, proFeeChangedLine, proFeeNoFeeWords, proFeeTick,
  proFeeTickStartsLine, type ProFeeStanding,
} from './provider-fee';

// [BILL-PRO PR6 · REVIEW-F #2231 S3/S4 · REVIEW-M #2229 N1] A pro reads the same words about their weekly fee on the
// website as in the app (page for screen): the phone's lib/providerFee.ts is read as text and every sentence the web
// page can show must be there, so a change on one side alone goes red here.
const phone = readFileSync(join(__dirname, '..', '..', '..', 'mobile', 'src', 'lib', 'providerFee.ts'), 'utf8')
  .replace(/\\u2019/g, '’').replace(/\\u201c/g, '“').replace(/\\u201d/g, '”').replace(/\\'/g, "'");

const TERMS = { version: 'v1', items: [{ heading: 'What it covers', text: 'The Swift app.' }], tick: 'I understand the weekly fee.', amount: 8000, currencyCode: 'GYD', acknowledged: false };
const ON: ProFeeStanding = { required: true, operable: false, why: 'FEE_TERMS', source: null, subscriptionId: null };
const OFF: ProFeeStanding = { required: false, operable: true };

describe('the pro fee words on the website are the phone\'s', () => {
  it('a store-covered pro: one fee (the store\'s) and an in-flight payment kept as credit, never "no separate fee"', () => {
    expect(PRO_FEE_COVERED_COPY).toContain('covers your provider profile: you pay one fee');
    expect(PRO_FEE_COVERED_COPY).toContain('kept as credit on your provider fee, never lost');
    expect(PRO_FEE_COVERED_COPY).not.toMatch(/needs no separate fee/);
    expect(phone).toContain(`'${PRO_FEE_COVERED_COPY.replace('Weekly fee page', 'Weekly fee screen')}'`);
  });

  it('the covered pro\'s tick line, the own-fee link, the agreement card and the "starts today" line', () => {
    expect(phone).toContain(`'${PRO_FEE_COVERED_TICK_LINE}'`);
    expect(phone).toContain(`'${PRO_FEE_OWN_FEE_LINK}'`);
    const agreement = proFeeAgreementFirst({ data: null, standing: { ...ON, why: 'AGREEMENT' }, feeTerms: TERMS })!;
    expect(phone).toContain(`title: '${agreement.title}'`);
    expect(phone).toContain(`body: '${agreement.body}'`);
    expect(phone).toContain(`'${proFeeTickStartsLine({ data: null, standing: ON, feeTerms: TERMS }, true)}'`);
  });

  it('every no-fee card', () => {
    const cards = [
      proFeeNoFeeWords({ data: null, standing: OFF }, true),
      proFeeNoFeeWords({ data: null, standing: { ...ON, why: 'AGREEMENT' } }, true),
      proFeeNoFeeWords({ data: null, standing: { ...ON, why: 'MISSING' } }, false),
      proFeeNoFeeWords({ data: null, standing: { ...ON, why: 'MISSING' } }, true),
    ];
    expect(new Set(cards.map((c) => c.title)).size).toBe(4);
    for (const c of cards) expect(phone).toContain(`{ title: '${c.title}', body: '${c.body}', action: ${c.action ? `'${c.action}'` : 'null'} }`);
  });

  it('the fee-changed line (amounts in each app\'s own money words)', () => {
    const line = proFeeChangedLine({ data: null, standing: ON, feeTerms: { ...TERMS, amount: 9000, changed: true, acknowledgedAmount: 8000, acknowledgedCurrencyCode: 'GYD' } })!;
    const tail = /return `The weekly fee changed from \$\{[^}]+\} to \$\{[^}]+\} a week\. ([^`]+)`;/.exec(phone)?.[1];
    expect(tail).toBeTruthy();
    expect(line).toBe(`The weekly fee changed from GY$8,000 to GY$9,000 a week. ${tail}`);
  });

  it('the tick\'s key names the words and the amount, as the phone\'s', () => {
    const t = proFeeTick({ data: null, standing: ON, feeTerms: TERMS });
    expect(t.kind === 'tick' && t.key).toBe('v1:8000:GYD');
    expect(phone).toContain('key: `${t.version}:${t.amount}:${t.currencyCode}`');
  });
});
