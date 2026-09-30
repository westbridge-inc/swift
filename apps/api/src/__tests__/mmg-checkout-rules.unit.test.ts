import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { bindingOf, candidatesFrom, judge, sameMsisdn } from '../modules/billing/mmg-checkout.service';
import {
  FEE_CHECKOUT_PLATFORMS_KEY,
  checkoutAmountGyd,
  clientPlatform,
  feePayActions,
  mmgCheckoutLive,
  resetFeeCheckoutSwitchCache,
} from '../modules/billing/fee-pay-actions';
import { FEE_RESTORE_LINE, feeCoveredLine, feeDueLine, guyanaDay, mmgPayLine } from '../modules/billing/fee-notice-copy';
import type { MmgCheckoutProvider } from '../providers/mmg/mmg-checkout';
import { MMG_LOOKUP_REFERENCE_FIELDS, echoedReferencesFrom, type MmgLookupDetail } from '../providers/mmg/mmg-provider';
import { PROVIDER_IDENTITY_BACKFILL_KEY } from '../modules/billing/provider-identity-backfill';

// ---------------------------------------------------------------------------
// The rules of the MMG weekly-fee checkout that need no database: which MMG
// transaction a reply may name, what a lookup answer means for a checkout,
// when the pay action is live, and what a fee notice may say.
// (MMG-CHECKOUT-API.md is the contract; mmg-checkout-service.test.ts runs the
// same rules against the database.)
// ---------------------------------------------------------------------------

const REF = '179000000000012345';
const OTHER_REF = '179000000000099999';
const MERCHANT = '5926000001';
const intent = { merchantTransactionId: REF, amount: new Prisma.Decimal(1500), currencyCode: 'GYD', createdAt: new Date('2026-09-29T12:00:00Z') };
const found = (patch: Partial<Extract<MmgLookupDetail, { outcome: 'found' }>> = {}): MmgLookupDetail => ({
  outcome: 'found', transactionId: 'MMGTX1', status: 'approved', amountMinor: 150_000, currencyCode: 'GYD',
  creditParties: [MERCHANT], createdAt: '2026-09-29T12:05:00Z', echoedReferences: [], raw: { transactionReference: 'MMGTX1' }, ...patch,
});
/** MMG's answer echoing THIS checkout's reference in the confirmed field [F1]. */
const echo = { echoedReferences: [REF] };

describe('which MMG transaction a reply may be naming (reply field names are unconfirmed)', () => {
  it('takes id-shaped values, id-like keys first, and never our reference, the amount, the merchant, a date or a secret', () => {
    const reply = {
      merchantTransactionId: REF,
      amount: '1500',
      merchant: MERCHANT,
      when: '2026-09-29T12:00:00Z',
      secretKey: 'SECRET999999',
      note: 'ZZ12345678',
      nested: { transactionId: 'MMG-TX-777' },
      message: 'Payment successful',
    };
    expect(candidatesFrom(reply, { merchantTransactionId: REF, amountGyd: 1500 }, [MERCHANT])).toEqual(['MMG-TX-777', 'ZZ12345678']);
  });

  it('is bounded: at most five candidates', () => {
    const reply = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`transactionId${i}`, `TX${100000 + i}`]));
    expect(candidatesFrom(reply, { merchantTransactionId: REF, amountGyd: 1500 }, [])).toHaveLength(5);
  });

  it('one MSISDN spelled with or without 592', () => {
    expect(sameMsisdn('5926000001', '6000001')).toBe(true);
    expect(sameMsisdn('+592 600-0001', '5926000001')).toBe(true);
    expect(sameMsisdn('5926000001', '5926000002')).toBe(false);
    expect(sameMsisdn('123', '123')).toBe(false);
  });
});

describe('what a lookup answer means for a checkout [I2 · F1]', () => {
  it('credits only an approved transaction of exactly the amount asked, in GYD, paid to our merchant, that MMG ties to THIS checkout', () => {
    expect(judge(intent, 'MMGTX1', found(echo), [MERCHANT])).toEqual({ verdict: 'CONFIRM', txnId: 'MMGTX1' });
    expect(judge(intent, 'MMGTX1', found({ ...echo, creditParties: ['6000001'] }), [MERCHANT]).verdict).toBe('CONFIRM');
    // The same reference in two confirmed fields is still one reference.
    expect(judge(intent, 'MMGTX1', found({ echoedReferences: [REF, REF] }), [MERCHANT]).verdict).toBe('CONFIRM');
  });

  it('[F1] an exact approved payment MMG does not tie to this checkout is held for a person at once, never credited', () => {
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT])).toEqual({ verdict: 'HOLD', txnId: 'MMGTX1', reason: 'REFERENCE_NOT_ECHOED', decisive: true });
  });

  it.each([
    ['another checkout’s reference', [OTHER_REF], 'REFERENCE_MISMATCH'],
    ['ours and another', [REF, OTHER_REF], 'REFERENCE_AMBIGUOUS'],
    ['our reference padded', [` ${REF}`], 'REFERENCE_MISMATCH'],
    ['our reference with a digit more', [`${REF}0`], 'REFERENCE_MISMATCH'],
  ] as const)('[F1] a lookup echoing %s is held at once', (_label, echoedReferences, reason) => {
    expect(judge(intent, 'MMGTX1', found({ echoedReferences: [...echoedReferences] }), [MERCHANT])).toMatchObject({ verdict: 'HOLD', reason, decisive: true });
  });

  it('[F1] our reference inside some other text binds nothing: there is no substring binding', () => {
    const verdict = judge(intent, 'MMGTX1', found({ raw: { description: `Swift ${REF}`, merchantTransactionId: REF } }), [MERCHANT]);
    expect(verdict).toMatchObject({ verdict: 'HOLD', reason: 'REFERENCE_NOT_ECHOED' });
  });

  it('[F1] a lookup that names another of our checkouts is held, even when it echoes this one', () => {
    expect(judge(intent, 'MMGTX1', found(echo), [MERCHANT], [OTHER_REF])).toMatchObject({ verdict: 'HOLD', reason: 'REFERENCE_OF_ANOTHER_CHECKOUT', decisive: true });
  });

  it.each([
    ['one cent short', { amountMinor: 149_999 }, 'AMOUNT_MISMATCH'],
    ['one dollar more', { amountMinor: 150_100 }, 'AMOUNT_MISMATCH'],
    ['an amount MMG did not send', { amountMinor: null }, 'AMOUNT_MISMATCH'],
    ['another currency', { currencyCode: 'USD' }, 'CURRENCY_MISMATCH'],
    ['no currency', { currencyCode: null }, 'CURRENCY_MISMATCH'],
    ['someone else’s merchant', { creditParties: ['5926999999'] }, 'MERCHANT_MISMATCH'],
    ['no merchant named', { creditParties: null }, 'MERCHANT_UNCONFIRMED'],
    ['a transaction a week before the checkout', { createdAt: '2026-09-22T12:00:00Z' }, 'OLDER_THAN_CHECKOUT'],
  ] as const)('holds %s for a person, never credits: at once when MMG ties it to this checkout, after the window otherwise', (_label, patch, reason) => {
    expect(judge(intent, 'MMGTX1', found(patch as never), [MERCHANT])).toMatchObject({ verdict: 'HOLD', reason, decisive: false });
    expect(judge(intent, 'MMGTX1', found({ ...(patch as object), ...echo } as never), [MERCHANT])).toMatchObject({ verdict: 'HOLD', reason, decisive: true });
  });

  it('declined, expired and reversed are not payments, and only MMG’s answer for THIS checkout says a payment failed [F5]', () => {
    for (const status of ['declined', 'expired', 'reversed'] as const) {
      expect(judge(intent, 'T', found({ status }), [MERCHANT])).toMatchObject({ verdict: 'DECLINED', bound: false });
      expect(judge(intent, 'T', found({ status, ...echo }), [MERCHANT])).toMatchObject({ verdict: 'DECLINED', bound: true });
    }
    expect(judge(intent, 'T', found({ status: 'declined', ...echo }), [MERCHANT], [OTHER_REF])).toMatchObject({ verdict: 'DECLINED', bound: false });
    expect(judge(intent, 'T', found({ status: 'pending', ...echo }), [MERCHANT]).verdict).toBe('PENDING');
    expect(judge(intent, 'T', { outcome: 'not_found' }, [MERCHANT]).verdict).toBe('NOT_FOUND');
    expect(judge(intent, 'T', { outcome: 'error', reason: 'x' }, [MERCHANT]).verdict).toBe('ERROR');
  });

  it('[F1] binding is exact: one distinct echoed value, equal to ours', () => {
    expect(bindingOf(REF, [])).toBe('NOT_ECHOED');
    expect(bindingOf(REF, [REF])).toBe('BOUND');
    expect(bindingOf(REF, [REF, REF])).toBe('BOUND');
    expect(bindingOf(REF, [OTHER_REF])).toBe('MISMATCH');
    expect(bindingOf(REF, [REF, OTHER_REF])).toBe('AMBIGUOUS');
  });
});

describe('the reference MMG’s lookup echoes [F1] (the field is UNCONFIRMED until UAT)', () => {
  it('no field is confirmed yet, so no lookup answer, whatever it carries, binds to a checkout', () => {
    expect(MMG_LOOKUP_REFERENCE_FIELDS).toEqual([]);
    const answer = { merchantTransactionId: REF, reference: REF, merchantReference: REF, externalReference: REF, orderId: REF, description: REF };
    expect(echoedReferencesFrom(answer)).toEqual([]);
  });

  it('reads exactly the named key paths, whole strings only: never a substring, never a number', () => {
    const answer = { a: REF, nested: { ref: REF }, text: `Swift ${REF}`, num: Number(REF), deep: { x: { y: OTHER_REF } } };
    expect(echoedReferencesFrom(answer, ['a'])).toEqual([REF]);
    expect(echoedReferencesFrom(answer, ['nested.ref', 'deep.x.y'])).toEqual([REF, OTHER_REF]);
    expect(echoedReferencesFrom(answer, ['text'])).toEqual([`Swift ${REF}`]);
    expect(echoedReferencesFrom(answer, ['num', 'missing', 'nested', 'a.b'])).toEqual([]);
    expect(echoedReferencesFrom(null, ['a'])).toEqual([]);
  });
});

describe('the backfill completion record [F2]', () => {
  it('lives under a key the admin config route can never write, so it cannot be set by hand', () => {
    // The route's own key rule, read from its source: widening it to allow ':'
    // would let a person switch checkout crediting on without the backfill.
    const routes = readFileSync(join(__dirname, '..', 'modules/admin/admin.routes.ts'), 'utf8');
    const literal = routes.match(/const configKeySchema = z\.string\(\)\.regex\(\/(.+?)\/([a-z]*),/);
    expect(literal, 'configKeySchema is still a single regex').not.toBeNull();
    const configKey = new RegExp(literal![1]!, literal![2]);
    expect(configKey.test('billing.feeCheckout.platforms')).toBe(true);
    expect(configKey.test(PROVIDER_IDENTITY_BACKFILL_KEY)).toBe(false);
  });
});

describe('the amount a checkout charges [I1]', () => {
  it('is the amount due rounded UP to whole GYD, or one week when nothing is due', () => {
    expect(checkoutAmountGyd({ weeklyFeeGyd: 2100, amountDueGyd: 2100 })).toBe(2100);
    expect(checkoutAmountGyd({ weeklyFeeGyd: 2100, amountDueGyd: 1049.5 })).toBe(1050);
    expect(checkoutAmountGyd({ weeklyFeeGyd: 2100, amountDueGyd: 1049.01 })).toBe(1050);
    expect(checkoutAmountGyd({ weeklyFeeGyd: 2100, amountDueGyd: 0 })).toBe(2100);
  });
});

// -- payActions ------------------------------------------------------------------

const liveProvider = () => ({ driver: 'sandbox', merchantId: MERCHANT }) as unknown as MmgCheckoutProvider;
const offProvider = () => ({ driver: 'disabled', merchantId: null }) as unknown as MmgCheckoutProvider;
const brokenProvider = (): MmgCheckoutProvider => { throw new Error('FATAL: MMG_CHECKOUT_MERCHANT_ID is required'); };
const sub = (patch: Record<string, unknown> = {}) => ({
  id: 'sub-1', status: 'ACTIVE' as const, feeWaived: false, currencyCode: 'GYD',
  weeklyRate: new Prisma.Decimal(2100), customRate: null, nextBillingDate: new Date('2026-10-02T12:00:00Z'), ...patch,
});
/** A test double of the one delegate the rule reads: the per-platform switch row. */
function configWith(value: unknown): Pick<PrismaClient, 'platformConfig'> {
  const findUnique = vi.fn(async ({ where }: { where: { key: string } }) => (where.key === FEE_CHECKOUT_PLATFORMS_KEY && value !== undefined ? { key: where.key, value } : null));
  return { platformConfig: { findUnique } } as unknown as Pick<PrismaClient, 'platformConfig'>;
}

describe('payActions — MMG_CHECKOUT is live only when it truly is, and off is hidden', () => {
  beforeEach(() => resetFeeCheckoutSwitchCache());

  it('is live with a configured checkout, a payable subscription and the platform switched on (a missing switch is ON)', async () => {
    for (const platform of ['ios', 'android', 'web', 'unknown'] as const) {
      resetFeeCheckoutSwitchCache();
      expect(await mmgCheckoutLive(configWith(undefined), sub(), platform, liveProvider), platform).toBe(true);
    }
  });

  it('is off when the checkout is not configured, or its configuration cannot load', async () => {
    expect(await mmgCheckoutLive(configWith(undefined), sub(), 'ios', offProvider)).toBe(false);
    expect(await mmgCheckoutLive(configWith(undefined), sub(), 'ios', brokenProvider)).toBe(false);
  });

  it.each(['PAUSED', 'CANCELLED'] as const)('is off for a %s subscription', async (status) => {
    expect(await mmgCheckoutLive(configWith(undefined), sub({ status }), 'ios', liveProvider)).toBe(false);
  });

  it('is off for a waived fee, a non-GYD subscription and a zero fee', async () => {
    expect(await mmgCheckoutLive(configWith(undefined), sub({ feeWaived: true }), 'ios', liveProvider)).toBe(false);
    expect(await mmgCheckoutLive(configWith(undefined), sub({ currencyCode: 'USD' }), 'ios', liveProvider)).toBe(false);
    expect(await mmgCheckoutLive(configWith(undefined), sub({ weeklyRate: new Prisma.Decimal(0) }), 'ios', liveProvider)).toBe(false);
  });

  it.each(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CHURNED'] as const)('a %s subscription can pay (paying rejoins a churned one)', async (status) => {
    expect(await mmgCheckoutLive(configWith(undefined), sub({ status }), 'android', liveProvider)).toBe(true);
  });

  it('the per-platform switch turns one platform off, and an unknown platform then counts as off', async () => {
    const config = configWith({ ios: false });
    expect(await mmgCheckoutLive(config, sub(), 'ios', liveProvider)).toBe(false);
    expect(await mmgCheckoutLive(config, sub(), 'android', liveProvider)).toBe(true);
    expect(await mmgCheckoutLive(config, sub(), 'web', liveProvider)).toBe(true);
    expect(await mmgCheckoutLive(config, sub(), 'unknown', liveProvider)).toBe(false);
  });

  it('only an explicit false switches a platform off', async () => {
    for (const value of [{ ios: 'no' }, { ios: 0 }, { ios: null }, [], 'off']) {
      resetFeeCheckoutSwitchCache();
      expect(await mmgCheckoutLive(configWith(value), sub(), 'ios', liveProvider), JSON.stringify(value)).toBe(true);
    }
  });

  it('the platform is what the client says, from the existing x-client-platform header', () => {
    expect(clientPlatform({ 'x-client-platform': 'iOS' })).toBe('ios');
    expect(clientPlatform({ 'x-client-platform': 'android' })).toBe('android');
    expect(clientPlatform({ 'x-client-platform': 'web' })).toBe('web');
    expect(clientPlatform({ 'x-client-platform': 'desktop' })).toBe('unknown');
    expect(clientPlatform({})).toBe('unknown');
  });

  it('payActions carry the amount only when live, CARD is off, and no agent, cash or Swift Number action exists', async () => {
    const prisma = {
      ...configWith(undefined),
      prepaidBalance: { findUnique: vi.fn(async () => ({ balance: new Prisma.Decimal(600) })) },
      // [#1389] payInfo's due-now reads an issued charge first; none here.
      subscriptionPayment: { findFirst: vi.fn(async () => null) },
      tenantBillingCurrency: { findUnique: vi.fn(async () => null) },
    } as never;
    expect(await feePayActions(prisma, sub(), 'ios', liveProvider)).toEqual([
      { id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1500, currencyCode: 'GYD' },
      { id: 'CARD', state: 'off' },
    ]);
    resetFeeCheckoutSwitchCache();
    const off = await feePayActions(prisma, sub(), 'ios', offProvider);
    expect(off).toEqual([{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }]);
    expect(JSON.stringify(off)).not.toMatch(/agent|cash|san|swift ?number|account/i);
  });
});

// -- notices ---------------------------------------------------------------------

/** What no partner-facing fee wording may offer (owner, 2026-09-29). */
const FORBIDDEN = /MMG agent|any agent|at an agent|cash|Swift Number|account number|coming soon/i;

describe('what a fee notice may say', () => {
  it('points to the checkout for exactly the amount, or states the amount and when it is due', () => {
    expect(mmgPayLine(1500)).toBe('Pay GY$1,500 with MMG in the Swift app.');
    expect(feeDueLine(2100, 'GYD', null)).toBe('The weekly fee of GY$2,100 is due now.');
    expect(feeDueLine(2100.5, 'GYD', new Date('2026-09-29T15:00:00Z'), { first: true })).toBe('Your first weekly fee of GY$2,100.50 is due on Tue 29 Sep.');
    expect(feeCoveredLine(2100, 'GYD', { first: true })).toBe('Your balance already covers your first weekly fee of GY$2,100.');
  });

  it('dates in Guyana time (UTC−4, no daylight saving)', () => {
    expect(guyanaDay(new Date('2026-09-30T03:59:00Z'))).toBe('Tue 29 Sep');
    expect(guyanaDay(new Date('2026-09-30T04:00:00Z'))).toBe('Wed 30 Sep');
  });

  it('never offers an agent, cash, a Swift Number or an account number, nor "coming soon"', () => {
    for (const line of [mmgPayLine(1500), feeDueLine(1, 'GYD', null), feeCoveredLine(1, 'GYD'), FEE_RESTORE_LINE]) {
      expect(line).not.toMatch(FORBIDDEN);
    }
  });
});

describe('the census: no fee-notice source offers an agent, cash, a Swift Number or an account number', () => {
  // Every string a fee notice is built from lives in these files. Comments may
  // name what was removed; code may not say it to a partner.
  const SOURCES = [
    'modules/billing/fee-notice-copy.ts',
    'modules/billing/fee-pay-actions.ts',
    'modules/billing/trial-fee-education.ts',
    'modules/billing/mmg-checkout.service.ts',
    'modules/billing/billing.service.ts',
  ];
  const PARTNER_OFFER = /MMG agent|any MMG agent|at an agent|Swift Number|Swift account number|coming soon|Pay cash/i;

  it.each(SOURCES)('%s', (file) => {
    const code = readFileSync(join(__dirname, '..', file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code.match(PARTNER_OFFER)?.[0] ?? null).toBeNull();
  });
});
