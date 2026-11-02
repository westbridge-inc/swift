'use client';

import { useQuery } from '@tanstack/react-query';
import { feeMoney } from '@/lib/fee-status';
import { formatAmount } from '@/lib/money';
import { FEE_LADDER, feeQuote, feeSteps, fetchSignupPricing, type FeeChoice, type SignupPricing } from '@/lib/signup-fee';
import { getDriverProfile, getRiderProfile } from '@/lib/mover-api';
import { getProfile } from '@/lib/vendor-api';
import { pickProfileStore } from '@/lib/profile-store';
import { storeKey } from '@/lib/store-scope';
import type { FeeFamily } from '@/lib/weekly-fee';

/**
 * [WEB-ONBOARDING · FLOW-QA F8 (S2)] A partner Swift has not approved yet has no weekly fee: GET /<family>/subscription
 * answers data: null, which is not a failure. As the app's price card does, this says the fee starts after approval and
 * shows the quote for THIS store's type or THIS vehicle: the free trial and the weekly amount, from the server's price
 * list (GET /auth/pricing, the numbers sign-up and billing use). A list that cannot be read claims no price. Loaded on
 * demand by the Weekly fee card, so the fee pages' first load does not carry it.
 */
export default function WeeklyFeeNotStarted({ family, storeId }: { family: FeeFamily; storeId: string | null }) {
  const pricing = useQuery({ queryKey: ['signup-pricing'], queryFn: fetchSignupPricing, retry: 0 });
  const store = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile, enabled: family === 'vendor' });
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile, enabled: family === 'rider' });
  const driver = useQuery({ queryKey: ['p-driver'], queryFn: getDriverProfile, enabled: family === 'driver' });
  const type = family === 'vendor' ? pickProfileStore(store.data, storeId)?.vendorType
    : ((family === 'rider' ? rider.data : family === 'driver' ? driver.data : null)?.['vehicleType'] as string | undefined);
  const choice: FeeChoice | null = !type ? null : family === 'vendor' ? { role: 'VENDOR', vendorType: type } : { role: 'MOVER', vehicleType: type };
  const p = pricing.data as (SignupPricing & { trialDays?: unknown }) | undefined;
  const rate = p && choice ? feeQuote(p, choice) : null;
  const trial = typeof p?.trialDays === 'number' && Number.isInteger(p.trialDays) && p.trialDays > 0 ? p.trialDays : null;
  const money = rate === null || !p ? null : p.currencyCode === 'GYD' ? feeMoney(rate) : formatAmount(rate, p.currencySymbol);
  const price = money ? `${trial ? `${trial} days free, then ` : ''}${money} a week. ` : '';
  return (
    <section className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-extrabold">Weekly fee</h1>
      <div className="space-y-3 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--swift-muted)]">Your weekly fee</p>
        <p className="text-2xl font-extrabold sm:text-3xl" data-testid="weekly-fee-status">Starts after Swift approves you</p>
        {!pricing.isLoading && <p className="text-sm">{price}Nothing is paid before that.</p>}
        {money && p && choice && feeSteps(p, choice) ? <p className="text-sm text-[var(--swift-muted)]">{FEE_LADDER}</p> : null}
      </div>
    </section>
  );
}
