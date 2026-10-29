import { isIP } from 'node:net';
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { BodyTooLargeError, readBoundedBody } from '@/lib/bounded-body';
import { swiftDesignVariables as tokens } from '@/lib/design-tokens';

export const dynamic = 'force-dynamic';
const words = {
  CONFIRMED: 'Payment received. Your Swift weekly fee is paid.',
  CONFIRMING: "We're confirming your payment with MMG. Don't pay again. You can close this page.",
  NOT_PAID: "MMG didn't complete this payment. You can try again in the Swift app.",
  UNKNOWN: 'Open the Swift app to see your weekly fee.',
};
type Context = { params: Promise<{ path: string[] }> };
const headers = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
};

// MMG may put its reply in the PATH of the registered address (its UAT sent
// …/payment/token=<reply>), so a return can arrive as /pay/mmg/success/token=<reply>,
// /pay/mmg/successtoken=<reply> or /pay/mmg/token=<reply>. Next has decoded each
// segment once, so an encoded token%3D… reads the same. The reply is forwarded
// exactly like ?token=, as params.token, and the outcome is only ever one of
// these words, so it never carries the reply.
const OUTCOMES = new Set(['success', 'error', 'response']);

// [MASTER-051] A return body is read under a hard cap and a deadline before any
// form parser sees it. The cap sits above the largest body the field rules
// below can ever accept — 16 values of 4096 characters, every byte
// percent-encoded (x3, about 197 KB with names and separators) — so no reply
// MMG can legitimately send is refused; deploy/Caddyfile enforces the same cap
// at the proxy.
// Only the two form encodings a browser return can carry are read at all.
const MAX_RETURN_BODY_BYTES = 256 * 1024;
const RETURN_BODY_DEADLINE_MS = 10_000;
const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

async function postedFields(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!FORM_TYPES.has(type.split(';')[0]!.trim().toLowerCase())) {
    await request.body?.cancel().catch(() => {});
    throw new Error('Unreadable return');
  }
  const bytes = await readBoundedBody(request, MAX_RETURN_BODY_BYTES, RETURN_BODY_DEADLINE_MS);
  // `bytes` owns its whole buffer (readBoundedBody allocates it exactly), so the
  // buffer is the body with nothing before or after it.
  return new Response(bytes.buffer as ArrayBuffer, { headers: { 'content-type': type } }).formData();
}

/**
 * [SEC-DOS F8] The partner's own address, as the site's proxy set it (the first
 * X-Forwarded-For entry), and only an IP literal. Forwarded to the API so its
 * per-source limits and its reply gate count each partner, not this server:
 * the API trusts the header only from the private network (TRUST_PROXY), and
 * over the public address the proxy replaces it.
 */
function clientAddress(request: Request): string | null {
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return isIP(first) ? first : null;
}

/**
 * [SEC-DOS F8] This page's own limit, per partner address, before the body is
 * read or anything is forwarded: a partner coming back from MMG sends one or
 * two returns, so 20 a minute is generous; requests with no readable address
 * (never, behind the site's proxy) share one bucket as large as the API's own
 * per-source ceiling. Fixed one-minute windows in this process, bounded in size.
 */
const RELAY_PER_CLIENT_PER_MINUTE = 20;
const RELAY_UNKNOWN_CLIENT_PER_MINUTE = 120;
const RELAY_MAX_TRACKED = 10_000;
const relayCounts = new Map<string, number>();
let relayWindowStartedAt = 0;
function relayAllowed(client: string | null, now = Date.now()): boolean {
  if (now - relayWindowStartedAt >= 60_000 || relayCounts.size >= RELAY_MAX_TRACKED) {
    relayCounts.clear();
    relayWindowStartedAt = now;
  }
  const key = client ?? 'unknown';
  const count = (relayCounts.get(key) ?? 0) + 1;
  relayCounts.set(key, count);
  return count <= (client ? RELAY_PER_CLIENT_PER_MINUTE : RELAY_UNKNOWN_CLIENT_PER_MINUTE);
}

/** How long the API asked us to wait before one more try (it only says so when replies are queued), 1 to 2 seconds. */
async function retryAfterMs(response: Response): Promise<number | null> {
  if (response.status !== 503) return null;
  const body = await response.json().catch(() => null);
  if (body?.error?.code !== 'TRY_AGAIN') return null;
  const seconds = Number(body?.error?.details?.retryAfterSeconds);
  return Math.min(2, Math.max(1, Number.isFinite(seconds) ? seconds : 1)) * 1000;
}

/** base64 or base64url with '=' padding, at most 4096 characters, like a query value. */
function replyOf(value: string): string {
  if (value.length > 4096 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error('Unreadable return');
  return value;
}

/** The outcome word and the reply the path carries, if any. Every other shape is unreadable. */
function readPath(path: unknown): { outcome: string; token: string | undefined } {
  if (!Array.isArray(path) || path.length < 1 || path.length > 2) throw new Error('Unreadable return');
  const [first, second] = path as unknown[];
  if (typeof first !== 'string' || first === '' || (second !== undefined && typeof second !== 'string')) throw new Error('Unreadable return');
  const joined = /^(success|error|response)?token=([\s\S]*)$/.exec(first);
  // A first segment that names the reply in any other way is not guessed at.
  if (!joined && /token=/i.test(first)) throw new Error('Unreadable return');
  const outcome = joined ? (joined[1] ?? 'response') : OUTCOMES.has(first) ? first : 'response';
  let token = joined ? replyOf(joined[2] ?? '') : undefined;
  if (second !== undefined) {
    const extra = /^token=([\s\S]*)$/.exec(second);
    // An unknown extra segment, or the reply a second time.
    if (!extra || token !== undefined) throw new Error('Unreadable return');
    token = replyOf(extra[1] ?? '');
  }
  return { outcome, token };
}

async function handle(request: Request, context: Context) {
  let state: keyof typeof words = 'UNKNOWN';
  let status = 200;
  const client = clientAddress(request);
  try {
    if (!relayAllowed(client)) {
      status = 429;
      await request.body?.cancel().catch(() => {});
      throw new Error('Too many returns');
    }
    const { outcome, token } = readPath((await context.params).path);
    const fields: unknown = request.method === 'POST' ? await postedFields(request) : new URL(request.url).searchParams;
    const entries: Array<[string, string]> = [];
    if (!fields || typeof fields !== 'object' || !('forEach' in fields) || typeof fields.forEach !== 'function') throw new Error('Unreadable return');
    fields.forEach((value: unknown, key: unknown) => {
      if (typeof key !== 'string' || typeof value !== 'string' || value.length > 4096 || entries.length >= 16) throw new Error('Unreadable return');
      entries.push([key, value]);
    });
    const params: Record<string, string | string[]> = Object.create(null);
    if (token !== undefined) {
      // The reply once, within the API's 16 values: a second copy of it, under
      // any letter case, or one value too many is unreadable.
      if (entries.length >= 16 || entries.some(([key]) => key.toLowerCase() === 'token')) throw new Error('Unreadable return');
      params['token'] = token;
    }
    for (const [key, value] of entries) {
      const previous = params[key];
      params[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
    }
    // [SEC-DOS F8] The API reads a reply from its token field only: a return without one is never relayed.
    if (!Object.keys(params).some((key) => key.toLowerCase() === 'token')) throw new Error('No reply to forward');
    const forward = () => fetch(`${process.env['API_URL'] ?? BROWSER_API_ORIGIN}/api/v1/billing/mmg-checkout/return`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(client ? { 'X-Forwarded-For': client } : {}) }, cache: 'no-store', redirect: 'error',
      body: JSON.stringify({ outcome, params }),
      signal: AbortSignal.timeout(10_000),
    });
    let response = await forward();
    // Too many replies were waiting to be opened: one more try after the wait the API asked for.
    const wait = await retryAfterMs(response);
    if (wait !== null) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      response = await forward();
    }
    if (response.ok) {
      const body = await response.json();
      const candidate = body?.data?.state;
      if (body?.success === true && Object.hasOwn(words, candidate)) state = candidate;
    }
  } catch (error) {
    // Deliberately no logging: URLs, form fields and fetch errors can carry return tokens.
    if (error instanceof BodyTooLargeError) status = 413;
  }
  // A route-handler document bypasses the React layout and all analytics. No
  // return input, outcome, amount, identity or reference reaches this HTML.
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Swift weekly fee</title><style>body{margin:0;background:${tokens['--swift-canvas']};color:${tokens['--swift-ink']};font:18px/1.6 system-ui,sans-serif}main{max-width:32rem;margin:10vh auto;padding:2rem}h1{font-size:2rem;line-height:1.2}a{display:inline-block;color:${tokens['--swift-red']};font-weight:650;text-underline-offset:4px}p{margin-top:1.5rem}</style></head><body><main><h1>Weekly fee</h1><p>${words[state]}</p><p><a href="swift://pay/mmg/return">Back to the Swift app</a></p><p><a href="/weekly-fee">Continue on the web</a></p></main></body></html>`, { status, headers });
}
export const GET = handle;
export const POST = handle;
