import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeeklyFee } from './weekly-fee';
import { SIGNUP_PRICING } from '@/test/weekly-fee-fixture';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · owner ruling 1 Nov 2026 (D1)] The weekly fee block at sign-up says the free trial, as the app's
// price card does ("14 days free, then GY$X a week": [F30] the web's GY$ fee money), from the server's own numbers: the price list's `trialDays`, and a
// catalogue step's own `trialDays` (7 for a NEW department store when Swift approves it: subscription/trial-length.ts)
// in the app's sentence. A price list without a trial length says no trial; the amount alone stays.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
const served = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const WITH_TRIAL = {
  ...SIGNUP_PRICING,
  trialDays: 14,
  vendors: { service: 7000, catalogue: [{ minItems: 0, rate: 9000, trialDays: 14 }, { minItems: 1000, rate: 20000, trialDays: 14 }, { minItems: 10000, rate: 45000, trialDays: 7 }] },
};

async function block(pricing: unknown, role: 'VENDOR' | 'MOVER', type: string) {
  fetchMock.mockImplementation(() => served(pricing));
  const view = render(<WeeklyFee role={role} type={type} onChange={() => {}} />);
  const text = (await view.findByRole('region', { name: 'Your weekly fee' })).textContent!;
  view.unmount();
  return text;
}

describe('[D1] the free trial, from the server, before the weekly fee', () => {
  it('a rider: "14 days free, then GY$6,000 a week"', async () => {
    expect(await block(WITH_TRIAL, 'MOVER', 'MOTORCYCLE')).toContain('Your weekly fee: 14 days free, then GY$6,000 a week');
  });

  it('a store: the trial on its starting rate, and the department step’s own shorter trial in the app’s words', async () => {
    const text = await block(WITH_TRIAL, 'VENDOR', 'STORE');
    expect(text).toContain('Your weekly fee: 14 days free, then GY$9,000 a week');
    expect(text).toContain('A new store with 10,000+ items when Swift approves it gets 7 days free.');
    expect(text).not.toContain('1,000+ items when Swift approves it gets');
  });

  it('a services business: its own rate after the trial, and no catalogue step to speak of', async () => {
    const text = await block(WITH_TRIAL, 'VENDOR', 'SERVICE');
    expect(text).toContain('Your weekly fee: 14 days free, then GY$7,000 a week');
    expect(text).not.toContain('items when Swift approves it gets');
  });

  it('no trial length from the server (an older API, or not a whole number of days): no trial is claimed', async () => {
    for (const trialDays of [undefined, 0, 2.5, '14']) {
      const text = await block({ ...SIGNUP_PRICING, trialDays }, 'MOVER', 'MOTORCYCLE');
      expect(text, String(trialDays)).toContain('Your weekly fee: GY$6,000 a week');
      expect(text, String(trialDays)).not.toMatch(/days free/);
    }
  });

  it('the words are the app’s price card’s', () => {
    const card = readFileSync(join(__dirname, '..', '..', '..', '..', 'mobile', 'src', 'components', 'onboarding', 'PricingCard.tsx'), 'utf8');
    expect(card).toContain('{p.trialDays} days free, then {fee(rate)}/week');
    expect(card).toContain('` A new store with ${step.minItems.toLocaleString()}+ items when Swift approves it gets ${bandTrialDays(step, p.trialDays)} days free.`');
  });
});
