import { NextResponse, type NextRequest } from 'next/server';
import { webOrderingOpen } from '@/lib/web-ordering';
import { webOrderingState } from '@/lib/launch-switch';

/**
 * [Item 7] The pre-launch front door.
 *
 * Until the switch (lib/launch-switch.ts, read on every request) says ordering
 * is live on the PUBLIC site,
 * every way into ordering there — the home feed, store pages and their cart
 * and checkout, the customer's orders and account — is answered by the
 * "Launching soon" page instead, at the same address. The policy, company,
 * pricing and partner pages are not listed below, so they never pass through
 * here: the card bank, the app stores and new partners always see them.
 *
 * Staging, previews and local runs keep the full marketplace: the decision is
 * made per host (lib/web-ordering.ts), because one container may answer both
 * staging.swiftgy.com and swiftgy.com.
 */
export function middleware(request: NextRequest) {
  // The deletion instructions sit under /account but are public by policy
  // (Google Play requires them reachable without the app).
  if (request.nextUrl.pathname === '/account/delete' || webOrderingOpen(request.headers.get('host'), webOrderingState())) {
    return NextResponse.next();
  }
  const frontDoor = request.nextUrl.clone();
  frontDoor.pathname = '/launching-soon';
  frontDoor.search = '';
  return NextResponse.rewrite(frontDoor);
}

export const config = {
  matcher: [
    '/',
    '/order/:path*',
    '/explore',
    '/market',
    '/cart',
    '/orders/:path*',
    '/courier',
    '/taxi',
    '/account/:path*',
    '/store/:path*',
    '/stores/:path*',
  ],
};
