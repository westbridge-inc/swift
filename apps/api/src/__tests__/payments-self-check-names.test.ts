import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as selfCheck from '../modules/billing/payments-self-check';

// ---------------------------------------------------------------------------
// [REVIEW-G S4-1 on #1524] A self-check FAIL line may name SETTINGS, never a
// value. It used to print any UPPER_SNAKE token a configuration message held:
// today every message holds only setting names, but a future message that put
// a value shaped like one in its text would have printed it. The names now
// come from an allow-list, and a census keeps that list equal to the settings
// the two loaders read and name (so a new setting is never silently dropped).
// ---------------------------------------------------------------------------

const VALUE_SHAPED = 'SECRET_VALUE_7Q9';

vi.mock('../providers/mmg/mmg-checkout', async (importOriginal) => {
  const real = await importOriginal<typeof import('../providers/mmg/mmg-checkout')>();
  return {
    ...real,
    loadMmgCheckoutConfig: () => {
      throw new Error('FATAL: MMG_CHECKOUT_SECRET_KEY must be 1-256 printable ASCII characters (it held SECRET_VALUE_7Q9). Refusing to start.');
    },
  };
});
vi.mock('../providers/card/powertranz-provider', async (importOriginal) => {
  const real = await importOriginal<typeof import('../providers/card/powertranz-provider')>();
  return {
    ...real,
    powerTranzConfigFromEnv: () => {
      throw new real.PowerTranzConfigError('POWERTRANZ_ID is missing or longer than 25 characters (sec. 4); it held SECRET_VALUE_7Q9');
    },
  };
});

describe('[REVIEW-G S4-1] a FAIL line names only known settings', () => {
  it('a value shaped like a setting name in a configuration message is never printed (card and MMG)', async () => {
    const printed = selfCheck.formatSelfCheck(await selfCheck.runPaymentsSelfCheck(['card', 'mmg'], { CARD_RAIL_PROVIDER: 'powertranz' }, {}));
    expect(printed).toBe([
      'FAIL card: settings complete (POWERTRANZ_ID)',
      'FAIL mmg: checkout settings and keys load (MMG_CHECKOUT_SECRET_KEY)',
    ].join('\n'));
    expect(printed).not.toContain(VALUE_SHAPED);
  });

  it('the allow-list is exactly the settings the card and MMG loaders read and name (census)', () => {
    const src = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');
    const TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
    const named = (text: string, thrown: RegExp) => [...text.matchAll(thrown)]
      .flatMap((m) => m[1]!.replace(/\$\{[^}]*\}/g, '').match(TOKEN) ?? []);
    const read = (text: string) => [...text.matchAll(/env\['([A-Z0-9_]+)'\]/g)].map((m) => m[1]!);
    const card = src('providers/card/powertranz-provider.ts');
    const mmg = src('providers/mmg/mmg-checkout.ts');
    const expected = new Set([
      'CARD_RAIL_PROVIDER', // read by the self-check itself
      ...named(card, /throw new PowerTranzConfigError\(([\s\S]*?)\);/g), ...read(card),
      ...named(mmg, /throw new Error\(([\s\S]*?)\);/g), ...read(mmg),
    ]);
    expect(expected.size).toBeGreaterThan(15);
    expect([...(selfCheck as { SELF_CHECK_SETTING_NAMES?: ReadonlySet<string> }).SELF_CHECK_SETTING_NAMES ?? []].sort()).toEqual([...expected].sort());
  });
});
