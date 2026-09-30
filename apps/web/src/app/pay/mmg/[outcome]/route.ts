import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';

export const dynamic = 'force-dynamic';
const words = {
  CONFIRMED: 'Payment received. Your Swift weekly fee is paid.',
  CONFIRMING: "We're confirming your payment with MMG. Don't pay again. You can close this page.",
  NOT_PAID: "MMG didn't complete this payment. You can try again in the Swift app.",
  UNKNOWN: 'Open the Swift app to see your weekly fee.',
};
type Context = { params: Promise<{ outcome: string }> };
const headers = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
};

async function handle(request: Request, context: Context) {
  let state: keyof typeof words = 'UNKNOWN';
  try {
    const { outcome } = await context.params;
    const fields: unknown = request.method === 'POST' ? await request.formData() : new URL(request.url).searchParams;
    const entries: Array<[string, string]> = [];
    if (!fields || typeof fields !== 'object' || !('forEach' in fields) || typeof fields.forEach !== 'function') throw new Error('Unreadable return');
    fields.forEach((value: unknown, key: unknown) => {
      if (typeof key !== 'string' || typeof value !== 'string' || value.length > 4096 || entries.length >= 16) throw new Error('Unreadable return');
      entries.push([key, value]);
    });
    const params: Record<string, string | string[]> = Object.create(null);
    for (const [key, value] of entries) {
      const previous = params[key];
      params[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
    }
    const response = await fetch(`${process.env['API_URL'] ?? BROWSER_API_ORIGIN}/api/v1/billing/mmg-checkout/return`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', redirect: 'error',
      body: JSON.stringify({ outcome, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = await response.json();
      const candidate = body?.data?.state;
      if (body?.success === true && Object.hasOwn(words, candidate)) state = candidate;
    }
  } catch { /* Deliberately no logging: URLs, form fields and fetch errors can carry return tokens. */ }
  // A route-handler document bypasses the React layout and all analytics. No
  // return input, outcome, amount, identity or reference reaches this HTML.
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Swift weekly fee</title><style>body{margin:0;background:#faf8f6;color:#261d20;font:18px/1.6 system-ui,sans-serif}main{max-width:32rem;margin:10vh auto;padding:2rem}h1{font-size:2rem;line-height:1.2}a{display:inline-block;color:#8e243f;font-weight:650;text-underline-offset:4px}p{margin-top:1.5rem}</style></head><body><main><h1>Weekly fee</h1><p>${words[state]}</p><p><a href="swift://pay/mmg/return">Back to the Swift app</a></p><p><a href="/weekly-fee">Continue on the web</a></p></main></body></html>`, { headers });
}
export const GET = handle;
export const POST = handle;
