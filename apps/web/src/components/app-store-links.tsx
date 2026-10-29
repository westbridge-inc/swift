'use client';

import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/lib/app-stores';
import { useAppStoresLive } from '@/lib/use-web-ordering';

/**
 * [G11] The App Store and Google Play links. They show only once the web
 * server's SWIFT_APP_STORES switch says the apps are live in both stores
 * (lib/launch-switch.ts): while it is off, while the answer is on its way, and
 * if the question fails, the site makes no store claim. Turning it on at
 * Release needs a site restart with the new setting, never a code change.
 */

const STORES = [
  { href: APP_STORE_URL, label: 'Swift on the App Store' },
  { href: GOOGLE_PLAY_URL, label: 'Swift on Google Play' },
] as const;

const INLINE_LINK = 'font-medium text-[var(--swift-red)] underline underline-offset-2';

/** The two links as a row of buttons; nothing at all until the apps are live. */
export function AppStoreLinks({ className = '' }: { className?: string }) {
  const live = useAppStoresLive();
  if (!live) return null;
  return (
    <ul aria-label="Get the Swift app" className={`flex flex-wrap gap-2 ${className}`}>
      {STORES.map(({ href, label }) => (
        <li key={href}>
          <a
            href={href}
            className="inline-flex min-h-11 items-center rounded-full border border-[var(--swift-border-strong)] px-4 text-sm font-semibold text-[var(--swift-ink)] transition-colors hover:bg-[var(--swift-subtle)]"
          >
            {label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** One sentence for running text: the promise while the apps are not live, the two links once they are. */
export function AppStoreSentence() {
  const live = useAppStoresLive();
  if (!live) return <>Store download links will appear here when available.</>;
  return (
    <>
      Get it on the{' '}
      <a className={INLINE_LINK} href={APP_STORE_URL}>App Store</a> or{' '}
      <a className={INLINE_LINK} href={GOOGLE_PLAY_URL}>Google Play</a>.
    </>
  );
}
