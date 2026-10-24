'use client';

import { useRef, useState, type FormEvent } from 'react';
import { accountApi, type Profile } from './account-api';
import { AccountFrame, buttonClass, fieldClass, useAccountQuery } from './account-frame';
import { DataUnavailable } from '@/components/data-unavailable';
import { StepUpDismissed, useStepUp } from './use-step-up';

export function ProfileSettings() {
  const profile = useAccountQuery('profile', accountApi.profile);
  return <AccountFrame title="Personal details">
    {profile.isError ? <DataUnavailable what="your profile" error={profile.error} onRetry={() => void profile.refetch()} />
      : profile.data ? <ProfileForm profile={profile.data} /> : <p role="status">Loading your profile…</p>}
    <MarketingPreference />
  </AccountFrame>;
}

function ProfileForm({ profile }: { profile: Profile }) {
  const stepUp = useStepUp();
  const [firstName, setFirstName] = useState(profile.firstName ?? '');
  const [lastName, setLastName] = useState(profile.lastName ?? '');
  const [email, setEmail] = useState(profile.email ?? '');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null); setSaved(false);
    try {
      const body = { firstName: firstName.trim(), lastName: lastName.trim(), ...(email.trim() ? { email: email.trim() } : {}) };
      await stepUp.withStepUp(() => accountApi.updateProfile(body));
      setSaved(true);
    } catch (e) { if (!(e instanceof StepUpDismissed)) setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return <><form onSubmit={save} className="space-y-4 sw-card p-5">
    <fieldset disabled={busy} className="space-y-4">
    <label className="block space-y-1"><span className="text-sm font-semibold">First name</span><input className={fieldClass} autoComplete="given-name" required maxLength={50} value={firstName} onChange={(e) => { setFirstName(e.target.value); setSaved(false); }} /></label>
    <label className="block space-y-1"><span className="text-sm font-semibold">Last name</span><input className={fieldClass} autoComplete="family-name" required maxLength={50} value={lastName} onChange={(e) => { setLastName(e.target.value); setSaved(false); }} /></label>
    <label className="block space-y-1"><span className="text-sm font-semibold">Email</span><input className={fieldClass} type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); setSaved(false); }} /></label>
    <p className="text-sm text-[var(--swift-muted)]">Leave email blank to keep your existing email.</p>
    <label className="block space-y-1"><span className="text-sm font-semibold">Phone number</span><input className={fieldClass} readOnly value={profile.phone} /></label>
    <p className="text-sm text-[var(--swift-muted)]">Your verified phone number cannot be changed here.</p>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">Your details are saved.</p>}
    <button className={buttonClass} disabled={busy || !firstName.trim() || !lastName.trim()}>{busy ? 'Saving…' : 'Save details'}</button>
  </form>{stepUp.dialog}</>;
}

function MarketingPreference() {
  const consent = useAccountQuery('consent', accountApi.consent);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const marketing = consent.data?.consents.find((c) => c.documentType === 'marketing_consent');
  const granted = marketing?.current === true && (marketing.state === 'granted' || marketing.state === 're_granted');
  async function change() {
    if (sending.current || !consent.data || consent.isError) return;
    sending.current = true; setBusy(true); setError(null);
    try { await accountApi.marketing(!granted); await consent.refetch(); }
    catch (e) { setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section className="space-y-3 sw-card p-5" aria-label="Notification preferences">
    <h2 className="font-bold">Notification preferences</h2>
    {consent.isError ? <DataUnavailable what="your preferences" error={consent.error} onRetry={() => void consent.refetch()} />
      : <label className="flex min-h-11 items-center justify-between gap-3"><span>Marketing messages<span className="block text-sm text-[var(--swift-muted)]">Offers and promos. Service messages stay on.</span></span>
        <input type="checkbox" checked={granted} disabled={busy || !consent.data} onChange={() => void change()} className="h-5 w-5 accent-[var(--swift-red)]" />
      </label>}
    <a href="/legal/marketing" className="inline-block py-2 text-sm underline">About marketing messages</a>
    {error && <p role="alert">{error}</p>}
  </section>;
}
