import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEE_LADDER, feeLadderLine } from './signup-fee';

// [RETIER · COORD 30 Oct 2026] ONE rule for which items a store's fee is priced on, said in ONE phrase everywhere: the
// server counts items on sale, plus items taken off sale, changed or removed in the last 7 days (partner/store-fee.ts
// catalogueCountWhere), and its "why" sentence, the website and the phone all say exactly the server's phrase.
const root = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
const serverPhrase = () => {
  const m = read('api', 'src', 'modules', 'partner', 'store-fee.ts').match(/export const CATALOGUE_COUNT_WORDS = '([^']+)';/);
  expect(m, 'the server names its count in CATALOGUE_COUNT_WORDS').not.toBeNull();
  return m![1]!;
};

describe('the catalogue count is worded the same on the server, the website and the phone', () => {
  it('the server phrase is the 7-day rule', () => {
    expect(serverPhrase()).toBe('taken off sale, changed or removed in the last 7 days');
  });

  it('the website sign-up line, the pricing page and the phone sign-up card each say "counting items <the server phrase>"', () => {
    const phrase = `counting items ${serverPhrase()}`;
    expect(FEE_LADDER).toContain(phrase);
    expect(read('web', 'src', 'app', '(marketing)', 'pricing', 'page.tsx').replace(/\s+/g, ' ')).toContain(phrase);
    expect(read('mobile', 'src', 'components', 'onboarding', 'PricingCard.tsx')).toContain(phrase);
  });

  it('[RETIER PR-C] the words for a re-tier switched on count a lower rate the same way, on the website and the phone', () => {
    const phrase = `counting items ${serverPhrase()}`;
    const on = feeLadderLine({ currencyCode: 'GYD', currencySymbol: '$', catalogueRetier: { on: true, noticeDays: 14 } } as Parameters<typeof feeLadderLine>[0]);
    expect(on.slice(FEE_LADDER.length)).toContain(phrase);
    const phone = read('mobile', 'src', 'lib', 'partnerPricing.ts');
    const afterBirth = phone.slice(phone.indexOf('export function afterBirthWords'));
    expect(afterBirth.slice(afterBirth.indexOf('if (!r.on)'))).toContain(phrase);
  });
});
