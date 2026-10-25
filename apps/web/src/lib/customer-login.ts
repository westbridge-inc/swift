'use client';

// The customer sign-in code check, on its own so the sign-in page loads only
// this and not the whole customer client (lib/customer is shared with the
// shopping pages). Same request and answers as before.
import { BROWSER_CLIENT, adoptSession } from './auth';
import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';

/** OTP login that accepts a CUSTOMER account (partner login rejects them). */
export async function verifyCustomerLogin(phone: string, code: string): Promise<{ user: any }> {
  const res = await fetch(`${API_URL}/api/v1/auth/verify-otp`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Swift-Client': BROWSER_CLIENT },
    body: JSON.stringify({ phone, code }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'That code is not valid.');
  const data = json.data;
  // [W-01] A browser client is answered with HttpOnly cookies and NO tokens,
  // so the user the server names is the signal a session exists.
  if (data.isNewUser || !data.user?.id) {
    throw new Error('No Swift account is registered to that number yet. Create your account on this page to continue.');
  }
  adoptSession(data.user.id);
  return { user: data.user };
}
