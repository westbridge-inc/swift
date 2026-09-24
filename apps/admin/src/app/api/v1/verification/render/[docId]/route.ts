import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// [DS110-15] A same-origin proxy for the API's signed render stream.
//
// The document renders on the API origin under a short-lived HMAC token; the
// console opens it in a new tab. A cross-origin tab cannot report whether the
// load succeeded, so `window.open` "succeeded" even when it showed a 404 — the
// false green that unlocked Approve without any evidence. This route mirrors
// `/api/v1/verification/render/:docId` on the admin origin and streams the
// upstream response, so the page can fetch it first and only unlock after an
// actual HTTP 200. The HMAC is still verified upstream — this proxy adds no
// read authority of its own.
//
// It also puts partner-uploaded bytes on the ADMIN origin, whose CSP permits
// inline script. Only the formats the API accepts at upload are served; any
// other type (HTML, SVG) would run as admin-origin script, so it is refused
// instead of relayed.
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export async function GET(request: NextRequest, context: { params: Promise<{ docId: string }> }) {
  const { docId } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(docId)) {
    return new Response('Not found', { status: 404 });
  }
  const api = process.env['NEXT_PUBLIC_API_URL'] || 'http://localhost:3000';
  const upstream = new URL(`/api/v1/verification/render/${encodeURIComponent(docId)}`, api);
  upstream.search = request.nextUrl.search;
  const res = await fetch(upstream, { redirect: 'manual' });
  const noStore = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };
  if (!res.ok) {
    // A refusal upstream (bad link, expired, purged) keeps its status so the
    // page sees it; its body is not relayed.
    await res.body?.cancel();
    return new Response(null, { status: res.status, headers: noStore });
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!INLINE_TYPES.has(type)) {
    await res.body?.cancel();
    return new Response('Unsupported document type', {
      status: 415,
      headers: { ...noStore, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(res.body, {
    status: 200,
    headers: { ...noStore, 'Content-Type': type, 'Content-Disposition': 'inline' },
  });
}
