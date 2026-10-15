import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRICE_PROMISE_BODY, PRICE_PROMISE_TITLE } from './pricePromiseCopy';

// [Legal research A12 · CAA s.31, s.33] The phone Home said "0% fees, always." beside a delivery fee. It now says
// the research's line (phone build 12), from one module shared word for word with the website.
const HOME = readFileSync(join(process.cwd(), 'src', 'modules', 'shop', 'screens', 'HomeScreen.tsx'), 'utf8');
const WEB = readFileSync(join(process.cwd(), '..', 'web', 'src', 'lib', 'price-promise.ts'), 'utf8');

describe('the phone price promise is the research’s line', () => {
  it('says no commission and no markup, the delivery fee shown first, and pickup free', () => {
    expect(`${PRICE_PROMISE_TITLE} ${PRICE_PROMISE_BODY}`).toBe('No commission and no markup on store prices. The delivery fee is shown before you order; pickup is free.');
  });

  it('matches the website word for word', () => {
    expect(WEB).toContain(`export const PRICE_PROMISE_TITLE = '${PRICE_PROMISE_TITLE}';`);
    expect(WEB).toContain(`export const PRICE_PROMISE_BODY = '${PRICE_PROMISE_BODY}';`);
  });

  it('Home shows it and no longer says "0% fees"', () => {
    expect(HOME).toMatch(/<T variant="bodyStrong">\{PRICE_PROMISE_TITLE\}<\/T>/);
    expect(HOME.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).not.toMatch(/0% fees/);
  });
});
