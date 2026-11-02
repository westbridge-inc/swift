'use client';

import { useQuery } from '@tanstack/react-query';
import { feeMoney } from '@/lib/fee-status';
import { formatAmount } from '@/lib/money';
import { FEE_LADDER, feeQuote, feeSteps, fetchSignupPricing, type FeeChoice, type SignupPricing } from '@/lib/signup-fee';
import { getDriverProfile, getRiderProfile } from '@/lib/mover-api';
import { getProfile } from '@/lib/vendor-api';
import { getStoreFee } from '@/lib/store-fee-api';
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
  // [REVIEW-LIGHT2 #2309 M] A store's OWN fee when the server has it (the step its own catalogue reaches now: the card
  // the Settings fee tick uses, same key), with that step's own trial from the price list (7 days at the department
  // step). Owner only: a manager's read is refused, and the tab falls back to the starting rate.
  const own = useQuery({ queryKey: storeKey(storeId, 'store-weekly-fee'), queryFn: () => getStoreFee(storeId!), enabled: family === 'vendor' && !!storeId, retry: 0 });
  const p = pricing.data as (SignupPricing & { trialDays?: unknown }) | undefined;
  const ownFee = own.data && own.data.vendorId === storeId ? own.data.weeklyFee : null;
  const bands = (p?.vendors?.catalogue ?? []) as Array<{ minItems: number; rate: number; tier?: string; trialDays?: unknown }>;
  const days = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  const listTrial = days(p?.trialDays);
  const rate = ownFee ? ownFee.amount : p && choice ? feeQuote(p, choice) : null;
  const currency = ownFee ? ownFee.currencyCode : p?.currencyCode;
  const trial = ownFee ? days(bands.find((b) => b.tier === ownFee.tier)?.trialDays) ?? listTrial : listTrial;
  const money = rate === null || !currency ? null : currency === 'GYD' ? feeMoney(rate) : formatAmount(rate, p?.currencySymbol ?? `${currency} `);
  const price = money ? `${trial ? `${trial} days free, then ` : ''}${money} a week. ` : '';
  // Without the store's own quote, the starting rate stands: the department step's own shorter trial, in the app's
  // price card's sentence (PricingCard), so a 10,000+ item store is not left reading 14 days.
  const stepTrials = !ownFee && listTrial && choice?.role === 'VENDOR' && choice.vendorType !== 'SERVICE'
    ? bands.slice(1).flatMap((b) => { const d = days(b.trialDays) ?? listTrial; return d === listTrial ? [] : [`A new store with ${b.minItems.toLocaleString()}+ items when Swift approves it gets ${d} days free.`]; })
    : [];
  return (
    <section className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-extrabold">Weekly fee</h1>
      <div className="space-y-3 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--swift-muted)]">Your weekly fee</p>
        <p className="text-2xl font-extrabold sm:text-3xl" data-testid="weekly-fee-status">Starts after Swift approves you</p>
        {!pricing.isLoading && !own.isLoading && <p className="text-sm">{price}Nothing is paid before that.</p>}
        {ownFee && own.data?.why ? <p className="text-sm text-[var(--swift-muted)]">{own.data.why}</p> : null}
        {!ownFee && money && p && choice && feeSteps(p, choice) ? <p className="text-sm text-[var(--swift-muted)]">{FEE_LADDER}</p> : null}
        {stepTrials.map((line) => <p key={line} className="text-sm text-[var(--swift-muted)]">{line}</p>)}
      </div>
    </section>
  );
}
