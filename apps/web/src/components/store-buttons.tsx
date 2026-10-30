'use client';

import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/lib/app-stores';
import { useAppStoresLive } from '@/lib/use-web-ordering';

/**
 * [WEBSITE 30 Oct · G11] The front door's store area. While the web server's SWIFT_APP_STORES switch is off
 * (and while its answer is on the way, or if the question fails) it is one calm line saying where the app is
 * coming: no dead badge, no disclaimer. Once the switch says live (on the public site only), the line becomes the
 * two real store buttons, the same two pages the footer and the phone app's update screen open.
 */
export function StoreButtons({ className = '' }: { className?: string }) {
  const live = useAppStoresLive();
  if (!live) {
    return (
      <p className={`inline-flex items-center gap-2.5 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 py-2.5 text-sm font-medium text-[var(--swift-ink)] ${className}`}>
        <span aria-hidden="true" className="size-2 rounded-full bg-[var(--swift-red)]" />
        Coming to the App Store and Google Play
      </p>
    );
  }
  return (
    <ul aria-label="Get the Swift app" className={`flex flex-wrap gap-3 ${className}`}>
      <li><a href={APP_STORE_URL} className="sw-btn sw-btn-ink">Download on the App Store</a></li>
      <li><a href={GOOGLE_PLAY_URL} className="sw-btn sw-btn-ink">Get it on Google Play</a></li>
    </ul>
  );
}
