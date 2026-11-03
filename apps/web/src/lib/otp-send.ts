import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';
import { BROWSER_CLIENT } from '@/lib/auth';
import { otpSendRefusal } from '@/lib/otp-send-refusal';

/**
 * [SIGNUP-PHONE · perf] Asking for a sign-in code, on its own: only sign-in and sign-up import it, so the refusal
 * words do not ride in lib/auth, which every page loads.
 */
export async function sendOtp(phone: string) {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Swift-Client': BROWSER_CLIENT },
      body: JSON.stringify({ phone }),
    });
  } catch {
    throw new Error(otpSendRefusal(0, null));
  }
  const json = await res.json().catch(() => ({}));
  // [SIGNUP-PHONE] Every refusal in words: the number again (400), try again (502), how long to wait (429).
  if (!res.ok || !json.success) {
    // The status and the server's wait ride along, so a page can count the send button down instead of showing an error.
    const details = json?.error?.details ?? {};
    const header = Number(res.headers.get('Retry-After'));
    const retryAfterSeconds = typeof details.retryAfterSeconds === 'number' ? details.retryAfterSeconds : header > 0 ? header : undefined;
    throw Object.assign(new Error(otpSendRefusal(res.status, json, res.headers.get('Retry-After'))), {
      status: res.status, retryAfterSeconds, codeAlreadySent: details.codeAlreadySent === true,
    });
  }
}
