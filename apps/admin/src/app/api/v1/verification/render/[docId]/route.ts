import { NextRequest } from 'next/server';

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
export async function GET(request: NextRequest, context: { params: Promise<{ docId: string }> }) {
  const { docId } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(docId)) {
    return new Response('Not found', { status: 404 });
  }
  const api = process.env['NEXT_PUBLIC_API_URL'] || 'http://localhost:3000';
  const upstream = new URL(`/api/v1/verification/render/${encodeURIComponent(docId)}`, api);
  upstream.search = request.nextUrl.search;
  const res = await fetch(upstream, { redirect: 'manual' });
  const headers = new Headers();
  headers.set('Content-Type', res.headers.get('content-type') ?? 'application/octet-stream');
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, { status: res.status, headers });
}
