// Swift live golden-path harness — HTTP client + auth helpers [SWIFT-081].
// Talks to a RUNNING Swift API over HTTP only (never the DB). Node 20 `fetch`.
//
// Auth model (probed against the live API):
//   verify-otp {phone, code:"000000"} — under DEV_OTP_BYPASS this both SKIPS the
//     stored-OTP check and still sets the `otp_verified:` flag register reads, so
//     send-otp is unnecessary. Skipping it also halves calls against the shared
//     5/min OTP rate bucket (send-otp + verify-otp both use it).
//     - existing account -> { isNewUser:false, user, tokens }  (login)
//     - new account      -> { isNewUser:true, phone }          (must register)
//   register {phone, firstName, lastName, role, countryCode, acceptTerms}
//     -> { user, tokens }
//   partner/become {role, business?|vehicle?}  (vendors/movers)

export const BASE = (process.env.LIVETEST_BASE_URL || 'http://localhost:3000') + '/api/v1';
export const OTP = process.env.LIVETEST_OTP || '000000';

export interface Res { status: number; ok: boolean; json: any; text: string }

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  // The OTP endpoints are rate-limited to 5/min per IP; seeding 18 accounts must
  // respect that. On a 429, back off past the 60s window and retry (paces to ~5/min).
  for (let attempt = 0; ; attempt += 1) {
    const r = await fetch(BASE + path, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (r.status === 429 && attempt < 8) { await sleep(13_000); continue; }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json, text };
  }
}

export const GET = (p: string, token?: string) => req('GET', p, { token });
export const POST = (p: string, body?: unknown, token?: string) => req('POST', p, { token, body });
export const PUT = (p: string, body?: unknown, token?: string) => req('PUT', p, { token, body });

export interface Session { token: string; userId: string }

/** Idempotent: log in if the account exists, else register it. Returns a session. */
export async function signupOrLogin(
  phone: string,
  who: { firstName: string; lastName: string; role: 'CUSTOMER' | 'MOVER' | 'VENDOR' },
): Promise<Session> {
  const v = await POST('/auth/verify-otp', { phone, code: OTP });
  const vd = v.json?.data;
  if (vd?.tokens?.accessToken) {
    return { token: vd.tokens.accessToken, userId: vd.user?.id ?? vd.user?.userId ?? '' };
  }
  const reg = await POST('/auth/register', {
    phone, firstName: who.firstName, lastName: who.lastName, role: who.role, countryCode: 'GY', acceptTerms: true,
  });
  const rd = reg.json?.data;
  if (!rd?.tokens?.accessToken) {
    throw new Error(`register failed for ${phone}: ${reg.status} ${reg.text.slice(0, 200)}`);
  }
  return { token: rd.tokens.accessToken, userId: rd.user?.id ?? rd.user?.userId ?? '' };
}

// Smallest valid PNG (correct magic bytes) — the /auth/selfie route magic-byte
// sniffs the upload, so a real header is required, not arbitrary bytes.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

/**
 * Capture the mandatory signup selfie (multipart upload). This is the ONLY
 * writer of selfieCapturedAt and it unlocks the transact gates — placing an
 * order, booking a ride, and going online all 403 SELFIE_REQUIRED without it.
 * Uses raw multipart (not `req`, which forces JSON); backs off on the 429 bucket.
 */
export async function captureSelfie(session: Session): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    const form = new FormData();
    form.append('file', new Blob([PNG_1x1], { type: 'image/png' }), 'selfie.png');
    const r = await fetch(BASE + '/auth/selfie', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      body: form,
    });
    if (r.status === 429 && attempt < 8) { await sleep(13_000); continue; }
    return r.ok;
  }
}

/** Log in an already-provisioned account (e.g. the kept SUPER_ADMIN). */
export async function login(phone: string): Promise<Session> {
  const v = await POST('/auth/verify-otp', { phone, code: OTP });
  const vd = v.json?.data;
  if (!vd?.tokens?.accessToken) throw new Error(`login failed for ${phone}: ${v.status} ${v.text.slice(0, 200)}`);
  return { token: vd.tokens.accessToken, userId: vd.user?.id ?? vd.user?.userId ?? '' };
}
