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

/**
 * [WEBSITE 30 Oct · G11] The front door's store area. While the switch is off (and while its answer is on the way,
 * or if the question fails) it is one calm line saying where the app is coming: no dead badge, no disclaimer. Once
 * the switch says live (on the public site only), the line becomes the two real store buttons. The buttons are one
 * 56 px row that never wraps (two short labels fit a 320 px phone), and the page reserves that row's height
 * (min-h-14 around this), so turning the stores on moves nothing on the page.
 * It lives beside AppStoreLinks so the page reuses the footer's code instead of shipping its own copy.
 */
export function StoreButtons() {
  const live = useAppStoresLive();
  if (!live) {
    return (
      <p className="inline-flex items-center gap-2.5 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 py-2.5 text-sm font-medium text-[var(--swift-ink)]">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--swift-red)]" />
        Coming to the App Store and Google Play
      </p>
    );
  }
  return (
    <ul aria-label="Get the Swift app" className={`flex flex-nowrap gap-3`}>
      {STORES.map(({ href }, i) => (
        <li key={href}>
          <a href={href} className="sw-btn sw-btn-ink flex-col gap-0 px-5 leading-none">
            <span className="text-[11px] font-medium">{i === 0 ? 'Download on the ' : 'Get it on '}</span>
            <span className="text-[17px]">{i === 0 ? 'App Store' : 'Google Play'}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
