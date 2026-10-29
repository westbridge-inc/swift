'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/auth';
import { addBranch, getBranchTerms } from '@/lib/branches-api';
import { useStoreRole } from '@/lib/store-role';
import { useStepUp, isStepUpDismissed } from '@/lib/step-up';
import { BRANCH_IS_CHECKED, BRANCH_TRIAL_IS_THE_BUSINESS, branchTrialLine, dealLine, weeklyFeeWords } from '@/lib/branches';
import { FEE_TICK_ERRORS } from '@/lib/signup-fee';
import type { StorePin } from '@/lib/store-pin';
import { loadStorePicker } from '@/app/signup/store-picker-loader';
import type { StoreLocationPicker as StoreLocationPickerComponent } from '@/components/store-location-picker';
import { DataUnavailable } from '@/components/data-unavailable';

const TYPES = [
  { value: 'RESTAURANT', label: 'Restaurant / food' },
  { value: 'SUPERMARKET', label: 'Supermarket / grocery' },
  { value: 'STORE', label: 'Shop / goods' },
  { value: 'SERVICE', label: 'Services' },
] as const;

const input = 'w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-2 text-sm';

/**
 * [CHAINS · owner 29 Oct 2026] Add a branch (owner only): the branch's own details (name, type, its private contact
 * phone, address and pin, as sign-up asks them) and [REVIEW-F #2220 S3-1] what go-live needs from the owner — the
 * number customers can call (required; the phone's call-us disclosure) and, for a restaurant, the food handlers tick
 * in the server's words (optional: Settings has it later) — then its terms as the server states them: its own weekly fee, ticked for
 * THIS branch; whether the business's running free trial covers it (only if Swift approves it before that trial
 * ends; a branch closed during the trial still uses it up); the chain's agreed rate, if any. Swift checks every new
 * branch before it goes live. Sending it asks this browser to confirm it's you (lib/step-up).
 */
export default function AddBranchPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role, known } = useStoreRole();
  const owner = role === 'OWNER';
  const [biz, setBiz] = useState({ name: '', vendorType: 'RESTAURANT', phone: '+592', addressLine1: '', city: '', region: '' });
  const [callUs, setCallUs] = useState('+592');
  const [pin, setPin] = useState<StorePin | null>(null);
  const [placing, setPlacing] = useState(false);
  const [Picker, setPicker] = useState<typeof StoreLocationPickerComponent | null>(null);
  const [pickerFailed, setPickerFailed] = useState(false);
  const loading = useRef(false);
  const loadPicker = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    setPickerFailed(false);
    loadStorePicker().then((m) => setPicker(() => m.StoreLocationPicker)).catch(() => setPickerFailed(true)).finally(() => { loading.current = false; });
  }, []);
  useEffect(() => { if (owner && !Picker) loadPicker(); }, [owner, Picker, loadPicker]);

  const terms = useQuery({ queryKey: ['branch-terms', biz.vendorType], queryFn: () => getBranchTerms(biz.vendorType), enabled: owner });
  const t = terms.data;
  const feeKey = t ? `${t.terms?.version ?? t.weeklyFee.version}|${t.weeklyFee.currencyCode}|${t.weeklyFee.amount}` : null;
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  const ticked = !!feeKey && tickedFor === feeKey;
  const fee = t ? weeklyFeeWords(t.weeklyFee.amount, t.weeklyFee.currencyCode) : null;
  const deal = t ? dealLine(t.dealWeeklyRate, t.dealCurrencyCode) : null;
  const full = !!t && t.stores >= t.limit;
  // The food handlers tick counts only for the words (and business type) it was given to.
  const food = t?.foodHandlers && typeof t.foodHandlers.tick === 'string' && t.foodHandlers.tick ? t.foodHandlers : null;
  const foodKey = food ? `${biz.vendorType}|${food.version}` : null;
  const [foodFor, setFoodFor] = useState<string | null>(null);
  const foodTicked = !!foodKey && foodFor === foodKey;

  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = (patch: Partial<typeof biz>, movesPin = false) => {
    setBiz((b) => ({ ...b, ...patch }));
    if (movesPin) { setPin(null); setPlacing(false); }
    setError(null);
  };
  const ready = owner && ticked && !!pin && !full && biz.name.trim().length >= 2 && biz.phone.trim().length >= 5
    && callUs.trim().length >= 8 && biz.addressLine1.trim().length >= 3 && biz.city.trim().length >= 2;

  const submit = async () => {
    if (!ready || !t || busy) return;
    setBusy(true);
    setError(null);
    const body = {
      business: {
        name: biz.name.trim(), vendorType: biz.vendorType, phone: biz.phone.trim(), addressLine1: biz.addressLine1.trim(),
        city: biz.city.trim(), ...(biz.region.trim() ? { region: biz.region.trim() } : {}), latitude: pin!.latitude, longitude: pin!.longitude,
      },
      weeklyFeeAck: { version: t.terms?.version ?? t.weeklyFee.version, amount: t.weeklyFee.amount, currencyCode: t.weeklyFee.currencyCode },
      publicPhone: callUs.trim(),
      ...(food && foodTicked ? { foodHandlers: { accept: true as const, attestationVersion: food.version } } : {}),
    };
    try {
      await stepUp.withStepUp(() => addBranch(body))();
      await queryClient.invalidateQueries({ queryKey: ['stores'] });
      router.push('/dashboard/branches');
    } catch (e) {
      if (isStepUpDismissed(e)) return;
      if (e instanceof ApiRequestError && e.code && FEE_TICK_ERRORS.includes(e.code)) {
        // The fee or its words changed since they were read: read them again and ask for the tick again.
        setTickedFor(null);
        void terms.refetch();
      }
      setError(e instanceof Error && e.message ? e.message : 'The branch wasn’t added. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (known && !owner) {
    return <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">Only the store owner can add a branch.</p>;
  }
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <Link href="/dashboard/branches" className="text-sm font-semibold text-[var(--swift-muted)] hover:underline">Back to branches</Link>
        <h1 className="sw-title mt-2">Add a branch</h1>
        <p className="sw-caption mt-1">A new store of your business, under this same login. Documents Swift already checked are not asked again.</p>
      </div>

      <section aria-labelledby="branch-details" className="sw-card space-y-3 p-5">
        <h2 id="branch-details" className="text-base font-bold">The branch</h2>
        <label className="block text-sm font-semibold">Branch name
          <input className={`${input} mt-1`} value={biz.name} onChange={(e) => edit({ name: e.target.value })} />
        </label>
        <label className="block text-sm font-semibold">Business type
          <select className={`${input} mt-1`} value={biz.vendorType} onChange={(e) => { edit({ vendorType: e.target.value }); setTickedFor(null); }}>
            {TYPES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </label>
        <label className="block text-sm font-semibold">Branch phone (Swift&apos;s contact line for the branch; customers don&apos;t see it)
          <input className={`${input} mt-1`} inputMode="tel" autoComplete="tel" value={biz.phone} onChange={(e) => edit({ phone: e.target.value })} />
        </label>
        <label className="block text-sm font-semibold">The number customers can call
          <input className={`${input} mt-1`} inputMode="tel" placeholder="+592 225 1234" aria-describedby="call-us-help" value={callUs} onChange={(e) => { setCallUs(e.target.value); setError(null); }} />
        </label>
        <p id="call-us-help" className="text-xs text-[var(--swift-muted)]">Shown on the branch&apos;s page so customers can call before they order. The branch goes live only with one. This is separate from the number you sign in with, which stays private.</p>
        {food && (
          <div className="space-y-1">
            <p className="text-sm font-semibold">Your food handlers</p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--swift-red)]" checked={foodTicked} onChange={(e) => setFoodFor(e.target.checked ? foodKey : null)} />
              <span>{food.tick}</span>
            </label>
            <p className="text-xs text-[var(--swift-muted)]">Needed before a restaurant branch goes live: tick it now or later in its Settings.</p>
          </div>
        )}
        <label className="block text-sm font-semibold">Street address
          <input className={`${input} mt-1`} autoComplete="street-address" disabled={placing} value={biz.addressLine1} onChange={(e) => edit({ addressLine1: e.target.value }, true)} />
        </label>
        <label className="block text-sm font-semibold">City or town
          <input className={`${input} mt-1`} autoComplete="address-level2" disabled={placing} value={biz.city} onChange={(e) => edit({ city: e.target.value }, true)} />
        </label>
        <label className="block text-sm font-semibold">Region
          <input className={`${input} mt-1`} autoComplete="address-level1" disabled={placing} value={biz.region} onChange={(e) => edit({ region: e.target.value }, true)} />
        </label>
        {placing ? (
          Picker ? <Picker current={pin} address={[biz.addressLine1, biz.city, biz.region].filter(Boolean).join(', ')} onConfirm={(p) => { setPin(p); setPlacing(false); }} onClose={() => setPlacing(false)} />
            : pickerFailed ? (
              <div role="alert" className="space-y-2">
                <p className="text-sm">The map didn&apos;t load. Check your connection; what you typed is kept.</p>
                <button type="button" className="sw-chip" onClick={loadPicker}>Try again</button>
                <button type="button" className="sw-chip" onClick={() => setPlacing(false)}>Back</button>
              </div>
            ) : <p role="status" className="text-sm">Loading the map…</p>
        ) : (
          <>
            <button type="button" className="sw-chip" disabled={!biz.addressLine1.trim() || !biz.city.trim()} onClick={() => { setPlacing(true); if (!Picker) loadPicker(); }}>
              {pin ? 'Move the branch pin' : 'Place the branch on the map'}
            </button>
            {pin && <p role="status" className="text-sm">Branch location confirmed: {pin.address ?? biz.addressLine1}.</p>}
          </>
        )}
      </section>

      <section aria-labelledby="branch-terms" className="sw-card space-y-3 p-5">
        <h2 id="branch-terms" className="text-base font-bold">This branch&apos;s weekly fee</h2>
        {terms.isLoading && <div role="status" className="sw-skeleton h-16"><span className="sr-only">Loading the branch&apos;s terms…</span></div>}
        {terms.isError && <DataUnavailable what="the branch's terms" error={terms.error} onRetry={() => void terms.refetch()} />}
        {t && fee && (
          <>
            <p className="text-sm"><strong>Each branch pays its own weekly fee: {fee}.</strong></p>
            <p className="text-sm">{branchTrialLine(t.sharedTrialEndsAt, fee)}</p>
            <p className="text-sm">{BRANCH_TRIAL_IS_THE_BUSINESS}</p>
            {deal && <p className="text-sm">{deal}</p>}
            {t.terms?.items.map((item) => <p key={item.heading} className="text-xs text-[var(--swift-muted)]"><strong>{item.heading}:</strong> {item.text}</p>)}
            <p className="text-sm">{BRANCH_IS_CHECKED}</p>
            {full && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">Your business has {t.stores} stores, the most one login can run ({t.limit}).</p>}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--swift-red)]" checked={ticked} onChange={(e) => setTickedFor(e.target.checked ? feeKey : null)} />
              <span>{t.terms?.tick ?? 'I understand the weekly fee'}</span>
            </label>
          </>
        )}
      </section>

      {error && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{error}</p>}
      <button type="button" className="sw-btn sw-btn-md w-full" disabled={!ready || busy} onClick={() => void submit()}>
        {busy ? 'Adding the branch…' : 'Add this branch'}
      </button>
      {stepUp.dialog}
    </div>
  );
}
