'use client';

// [PERF · web shared bundle] Sign-up and profile-photo calls, moved verbatim from
// lib/customer.ts so the shopping pages' shared customer client does not carry
// them. Only /signup and /selfie use them.
import { BROWSER_CLIENT, adoptSession, apiFetch } from './auth';
import { BROWSER_API_ORIGIN as API_BASE } from '@/lib/browser-api-origin';

/** Verify the OTP without deciding a role — returns whether the number is new. */
export async function verifyOtp(phone: string, code: string): Promise<{ isNewUser: boolean; user?: any; signedIn: boolean }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/verify-otp`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Swift-Client': BROWSER_CLIENT },
    body: JSON.stringify({ phone, code }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'That code is not valid.');
  const d = json.data;
  if (!d.isNewUser && d.user?.id) { adoptSession(d.user.id); return { isNewUser: false, user: d.user, signedIn: true }; }
  return { isNewUser: true, signedIn: false };
}

/** Register a brand-new account with the chosen role (after OTP verify). */
export async function registerAccount(body: { phone: string; firstName: string; lastName: string; role: 'CUSTOMER' | 'VENDOR' | 'MOVER'; countryCode?: string; acceptTerms?: boolean; ageConfirmed?: boolean }): Promise<{ user: any; roles: string[] }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Swift-Client': BROWSER_CLIENT },
    body: JSON.stringify({ countryCode: 'GY', ...body }),
  });
  const json = await res.json().catch(() => ({}));
  const registered = json?.data?.user;
  if (!res.ok || !registered?.id) throw new Error(json?.error?.message || 'Could not create your account.');
  adoptSession(registered.id);
  return { user: json.data.user, roles: json.data.user?.roles ?? [] };
}

/** Mandatory transact-gate photo. The API validates the actual image bytes and
 * is the only writer of avatar/selfieCapturedAt. */
export async function uploadSelfie(file: File): Promise<{ user: any }> {
  const form = new FormData();
  form.append('file', file, file.name || 'swift-profile-photo.jpg');
  return (await apiFetch('/api/v1/auth/selfie', { method: 'POST', body: form })).data as { user: any };
}

/** [ROLE-DOCS · owner 21 Oct 2026] Sign "I trade under my own name" for the store just created (in place of a business registration). */
export async function signOwnName() {
  return (await apiFetch('/api/v1/vendor/onboarding/own-name', { method: 'POST', body: JSON.stringify({ accept: true, attestationVersion: 'v1' }) })).data;
}

/** Partner onboarding — turn a fresh account into a vendor or a mover. */
export async function becomePartner(body: any) {
  return (await apiFetch('/api/v1/partner/become', { method: 'POST', body: JSON.stringify(body) })).data;
}
