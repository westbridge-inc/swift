// Swift live golden-path harness — HTTP client + auth helpers [SWIFT-081].
// Talks to a RUNNING Swift API over HTTP only (never the DB). Node 20 `fetch`.
//
// Auth model (probed against the live API):
//   verify-otp {phone, code:"000000"} — under DEV_OTP_BYPASS this skips the
//     stored-OTP check but still mints the one-use signup continuation, so
//     send-otp is unnecessary (and nothing is texted). send-otp and verify-otp
//     each have their own 5/min per-IP bucket.
//     - existing account -> { isNewUser:false, user, tokens }  (login)
//     - new account      -> { isNewUser:true, phone, registrationProof }
//   register {phone, registrationProof, firstName, lastName, role, countryCode, acceptTerms}
//     -> { user, tokens }
//   partner/become {role, business?|vehicle?}  (vendors/movers)

export const ORIGIN = (process.env.LIVETEST_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const BASE = ORIGIN + '/api/v1';
export const OTP = process.env.LIVETEST_OTP || '000000';

export interface Res { status: number; ok: boolean; json: any; text: string }

export interface ReqOpts {
  token?: string;
  body?: unknown;
  /** Extra headers (Idempotency-Key, x-device-id, x-vendor-id, …). */
  headers?: Record<string, string>;
  /** A multipart body; replaces `body` and the JSON content type. */
  form?: FormData;
  /** Default true: a 429 is paced and retried. Throttle checks set false to SEE the 429. */
  retry429?: boolean;
  /** Default true: a session near expiry is refreshed first. Revocation checks set false. */
  refresh?: boolean;
}

export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Every request is bounded: a wedged dependency must fail a step, never hang the run. */
const REQUEST_TIMEOUT_MS = Number(process.env.LIVETEST_REQUEST_TIMEOUT_MS || 45_000);

export async function req(method: string, path: string, opts: ReqOpts = {}): Promise<Res> {
  let token = opts.token;
  if (token && opts.refresh !== false) token = await freshToken(token);
  const headers: Record<string, string> = { ...(opts.form ? {} : { 'content-type': 'application/json' }), ...(opts.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  // The OTP endpoints are rate-limited to 5/min per IP; seeding 18 accounts must
  // respect that. On a 429, back off past the 60s window and retry (paces to ~5/min).
  for (let attempt = 0; ; attempt += 1) {
    const r = await fetch(BASE + path, {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(opts.form ? { body: opts.form } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (r.status === 429 && opts.retry429 !== false && attempt < 8) { await sleep(13_000); continue; }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json, text };
  }
}

export const GET = (p: string, token?: string) => req('GET', p, { token });
export const POST = (p: string, body?: unknown, token?: string) => req('POST', p, { token, body });
export const PUT = (p: string, body?: unknown, token?: string) => req('PUT', p, { token, body });
export const DEL = (p: string, token?: string, body?: unknown) => req('DELETE', p, { token, body });

/** The error code of a refusal ({ success:false, error:{ code } }), or '' . */
export const codeOf = (r: Res): string => String(r.json?.error?.code ?? '');

export interface Session {
  token: string;
  userId: string;
  /** Set when the session came from verify-otp/register/refresh; enables renewal. */
  refreshToken?: string;
  /** Epoch ms after which the access token is treated as stale. */
  expiresAt?: number;
}

// Access tokens live 15 minutes and a journey run is longer, so a session is
// renewed through POST /auth/refresh shortly before it lapses. Sessions are
// found by their current token, so every holder of the Session object sees
// the renewed token on its next request.
const sessions = new Map<string, Session>();
const RENEW_MARGIN_MS = 120_000;

function track(session: Session, tokens: { accessToken?: string; refreshToken?: string; expiresIn?: number } | undefined): Session {
  if (tokens?.refreshToken) session.refreshToken = tokens.refreshToken;
  session.expiresAt = Date.now() + (Number(tokens?.expiresIn) || 900) * 1000;
  sessions.set(session.token, session);
  return session;
}

async function freshToken(token: string): Promise<string> {
  const s = sessions.get(token);
  if (!s?.refreshToken || !s.expiresAt || s.expiresAt - Date.now() > RENEW_MARGIN_MS) return token;
  const r = await req('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken }, refresh: false });
  const t = r.json?.data;
  if (!r.ok || !t?.accessToken) return token; // the caller's request will surface the 401
  sessions.delete(s.token);
  s.token = t.accessToken;
  track(s, t);
  return s.token;
}

/** A session from an auth response body ({ user, tokens }). */
export function sessionFrom(data: any): Session {
  return track({ token: data.tokens.accessToken, userId: data.user?.id ?? data.user?.userId ?? '' }, data.tokens);
}

/** Idempotent: log in if the account exists, else register it. Returns a session. */
export async function signupOrLogin(
  phone: string,
  who: { firstName: string; lastName: string; role: 'CUSTOMER' | 'MOVER' | 'VENDOR' },
): Promise<Session> {
  const v = await POST('/auth/verify-otp', { phone, code: OTP });
  const vd = v.json?.data;
  if (vd?.tokens?.accessToken) {
    return sessionFrom(vd);
  }
  if (!vd?.isNewUser || typeof vd.registrationProof !== 'string') {
    throw new Error(`verify-otp did not return a session or signup continuation for ${phone}: ${v.status} ${v.text.slice(0, 200)}`);
  }
  const reg = await POST('/auth/register', {
    phone,
    registrationProof: vd.registrationProof,
    firstName: who.firstName,
    lastName: who.lastName,
    role: who.role,
    countryCode: 'GY',
    acceptTerms: true,
  });
  const rd = reg.json?.data;
  if (!rd?.tokens?.accessToken) {
    throw new Error(`register failed for ${phone}: ${reg.status} ${reg.text.slice(0, 200)}`);
  }
  return sessionFrom(rd);
}

// Smallest valid PNG (correct magic bytes) — the /auth/selfie route magic-byte
// sniffs the upload, so a real header is required, not arbitrary bytes.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

/** Log in an already-provisioned account (e.g. the kept SUPER_ADMIN). */
export async function login(phone: string): Promise<Session> {
  const v = await POST('/auth/verify-otp', { phone, code: OTP });
  const vd = v.json?.data;
  if (!vd?.tokens?.accessToken) throw new Error(`login failed for ${phone}: ${v.status} ${v.text.slice(0, 200)}`);
  return sessionFrom(vd);
}

/** The 1×1 PNG, for image uploads (the server sniffs magic bytes; roster.ts makes each copy unique). */
export const FIXTURE_PNG = PNG_1x1;

/** Multipart upload of one file plus text fields. */
export async function upload(
  path: string,
  token: string,
  file: { field?: string; name: string; type: string; bytes: Buffer },
  fields: Record<string, string> = {},
  method = 'POST',
): Promise<Res> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append(file.field ?? 'file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  return req(method, path, { token, form });
}
