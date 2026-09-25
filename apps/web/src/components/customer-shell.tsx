'use client';

import { useEffect, useRef, type ComponentType } from 'react';
import Link from 'next/link';
import { ChevronLeft, CircleUser, House, Menu, Search, ShoppingBag, Store, User, X } from 'lucide-react';
import { SwiftLogo } from '@/components/swift-logo';
import type { SessionStatus } from '@/components/customer-session';
import { signInPath, signUpPath, type CustomerTab, type SignInDoor as SignInDoorCopy } from '@/lib/customer-routes';

/**
 * [Q7b] The chrome of the customer app — the parts that stay put while pages
 * change underneath them. The shell (app/(app)/layout.tsx) owns the state;
 * these only draw it.
 *
 * Phone widths get the phone app's dock at the bottom and a compact bar at the
 * top; from `md` up the same destinations sit in a top bar and the dock goes
 * away. Tabs, names and order are the phone app's HomeTabs.
 */

/** Press feedback for anything tappable in the app: a small give under the
 *  finger, and none at all for people who asked for less motion. */
export const PRESS =
  'transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100';

interface TabLink {
  tab: CustomerTab;
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
}

const TABS: TabLink[] = [
  { tab: 'home', href: '/', label: 'Home', Icon: House },
  { tab: 'market', href: '/market', label: 'Market', Icon: Store },
  { tab: 'cart', href: '/cart', label: 'Cart', Icon: ShoppingBag },
  { tab: 'profile', href: '/account', label: 'Profile', Icon: User },
];

/** Market is shown only when the server's depth verdict says so — exactly the
 *  phone app's rule, so the two never disagree about whether it exists. */
export function visibleTabs(marketVisible: boolean): TabLink[] {
  return TABS.filter((tab) => tab.tab !== 'market' || marketVisible);
}

/** The company pages, one tap from the app: the marketing site still exists. */
export const BUSINESS_LINKS = [
  { href: '/vendors', label: 'Sell on Swift' },
  { href: '/drivers', label: 'Drive with Swift' },
  { href: '/about', label: 'About' },
] as const;

const MORE_LINKS = [
  ...BUSINESS_LINKS,
  { href: '/welcome', label: 'Why Swift' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing for businesses' },
  { href: '/faq', label: 'Questions' },
  { href: '/contact', label: 'Contact' },
] as const;

export function TopBar({
  activeTab,
  marketVisible,
  status,
  showBack,
  onBack,
  menuOpen,
  onMenuChange,
  returnPath,
}: {
  activeTab: CustomerTab;
  marketVisible: boolean;
  status: SessionStatus;
  showBack: boolean;
  onBack: () => void;
  menuOpen: boolean;
  onMenuChange: (_open: boolean) => void;
  returnPath: () => string;
}) {
  const guest = status === 'guest';
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--swift-border)] bg-[var(--swift-card)]/95 pt-[env(safe-area-inset-top)] backdrop-blur">
      <nav aria-label="Swift for business" className="hidden border-b border-[var(--swift-border)] md:block">
        <ul className="mx-auto flex max-w-6xl items-center justify-end gap-5 px-4 py-1.5 text-xs font-semibold text-[var(--swift-muted)]">
          {BUSINESS_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="hover:text-[var(--swift-ink)]">{link.label}</Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
        {showBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className={`-ml-2 grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-[var(--swift-subtle)] ${PRESS}`}
          >
            <ChevronLeft className="h-6 w-6" aria-hidden />
          </button>
        ) : null}
        <Link href="/" aria-label="Swift home" className="shrink-0">
          <SwiftLogo />
        </Link>

        <nav aria-label="Swift sections" className="ml-4 hidden items-center gap-1 md:flex">
          {visibleTabs(marketVisible)
            .filter((tab) => tab.tab === 'home' || tab.tab === 'market')
            .map(({ tab, href, label }) => (
              <Link
                key={tab}
                href={href}
                aria-current={activeTab === tab ? 'page' : undefined}
                className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ${
                  activeTab === tab ? 'bg-[var(--swift-red-50)] text-[var(--swift-red)]' : 'text-[var(--swift-muted)] hover:text-[var(--swift-ink)]'
                }`}
              >
                {label}
              </Link>
            ))}
        </nav>

        <Link
          href="/order/search"
          aria-label="Search Swift"
          className={`ml-auto flex h-10 items-center gap-2 rounded-full border border-[var(--swift-border)] px-3 text-sm text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] md:w-72 md:px-4 ${PRESS}`}
        >
          <Search className="h-4.5 w-4.5" aria-hidden />
          <span className="hidden md:inline">Search Swift</span>
        </Link>

        <Link
          href="/cart"
          aria-label="Cart"
          aria-current={activeTab === 'cart' ? 'page' : undefined}
          className={`hidden h-10 w-10 place-items-center rounded-full border border-[var(--swift-border)] hover:bg-[var(--swift-subtle)] md:grid ${PRESS}`}
        >
          <ShoppingBag className="h-4.5 w-4.5" aria-hidden />
        </Link>
        {status === 'checking' ? (
          // The account slot keeps its size while the one probe is answered.
          <span aria-hidden className="hidden h-10 w-10 md:block" />
        ) : guest ? (
          <Link
            href={signInPath(returnPath())}
            className="hidden rounded-full bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-[var(--swift-white)] hover:bg-[var(--swift-red-600)] md:inline-block"
          >
            Sign in
          </Link>
        ) : (
          <Link
            href="/account"
            aria-label="Profile"
            aria-current={activeTab === 'profile' ? 'page' : undefined}
            className={`hidden h-10 w-10 place-items-center rounded-full border border-[var(--swift-border)] hover:bg-[var(--swift-subtle)] md:grid ${PRESS}`}
          >
            <CircleUser className="h-4.5 w-4.5" aria-hidden />
          </Link>
        )}

        <button
          type="button"
          onClick={() => onMenuChange(true)}
          aria-label="More from Swift"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          className={`-mr-1 grid h-10 w-10 place-items-center rounded-full hover:bg-[var(--swift-subtle)] md:hidden ${PRESS}`}
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {menuOpen ? <MoreMenu guest={guest} returnPath={returnPath} onClose={() => onMenuChange(false)} /> : null}
    </header>
  );
}

/** Phone widths: the company pages, sign-in, and a way back out. */
function MoreMenu({ guest, returnPath, onClose }: { guest: boolean; returnPath: () => string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { close.current?.focus(); }, []);
  return (
    <div
      className="fixed inset-0 z-50 md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="More from Swift"
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
    >
      <button type="button" aria-label="Close menu" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-[var(--swift-scrim)]" />
      <div className="absolute inset-x-0 top-0 max-h-full overflow-y-auto overscroll-contain rounded-b-3xl bg-[var(--swift-card)] px-4 pb-6 pt-[calc(env(safe-area-inset-top)_+_0.5rem)] shadow-[var(--swift-elevation-floating)]">
        <div className="flex h-12 items-center justify-between">
          <SwiftLogo />
          <button ref={close} type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full hover:bg-[var(--swift-subtle)]">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <ul className="mt-2 divide-y divide-[var(--swift-border)]">
          {MORE_LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} onClick={onClose} className="block py-3.5 text-base font-semibold">{link.label}</Link>
            </li>
          ))}
        </ul>
        {guest ? (
          <div className="mt-4 grid gap-2">
            <Link href={signInPath(returnPath())} onClick={onClose} className="rounded-full bg-[var(--swift-red)] py-3 text-center font-semibold text-[var(--swift-white)]">
              Sign in
            </Link>
            <Link href={signUpPath(returnPath())} onClick={onClose} className="rounded-full border border-[var(--swift-border-strong)] py-3 text-center font-semibold">
              Create an account
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The phone app's dock: Home · Market · Cart · Profile, phone widths only. */
export function TabBar({ activeTab, marketVisible }: { activeTab: CustomerTab; marketVisible: boolean }) {
  return (
    <nav
      aria-label="Swift tabs"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--swift-border)] bg-[var(--swift-card)] pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex max-w-md">
        {visibleTabs(marketVisible).map(({ tab, href, label, Icon }) => {
          const active = activeTab === tab;
          return (
            <li key={tab} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 ${PRESS} ${
                  active ? 'text-[var(--swift-red)]' : 'text-[var(--swift-muted-soft)]'
                }`}
              >
                <Icon className="h-6 w-6" strokeWidth={active ? 2.4 : 1.8} aria-hidden />
                <span className={`text-[length:var(--swift-type-micro)] leading-none ${active ? 'font-semibold' : 'font-medium'}`}>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A private page, opened by a guest: say what it is for and offer sign-in,
 *  inside the app — the tabs stay, like the phone app's guest screens. */
export function SignInDoor({ door, returnPath }: { door: SignInDoorCopy; returnPath: string }) {
  return (
    <section
      aria-labelledby="sign-in-door-title"
      className="mx-auto mt-6 max-w-md rounded-3xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-8 text-center shadow-[var(--swift-elevation-card)]"
    >
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[var(--swift-red-50)]">
        <User className="h-6 w-6 text-[var(--swift-red)]" aria-hidden />
      </span>
      <h1 id="sign-in-door-title" className="mt-4 text-xl font-extrabold">{door.title}</h1>
      <p className="mt-2 text-sm text-[var(--swift-muted)]">{door.body}</p>
      <div className="mt-6 grid gap-2">
        <Link href={signInPath(returnPath)} className={`rounded-full bg-[var(--swift-red)] py-3 font-semibold text-[var(--swift-white)] hover:bg-[var(--swift-red-600)] ${PRESS}`}>
          Sign in
        </Link>
        <Link href={signUpPath(returnPath)} className={`rounded-full border border-[var(--swift-border-strong)] py-3 font-semibold hover:bg-[var(--swift-subtle)] ${PRESS}`}>
          Create an account
        </Link>
        <Link href="/" className="py-2 text-sm font-semibold text-[var(--swift-muted)] hover:text-[var(--swift-ink)]">
          Keep browsing
        </Link>
      </div>
    </section>
  );
}

/** What a private page shows while its sign-in answer is on the way: the
 *  shape of a page, inside the chrome — never a blank screen. */
export function ContentSkeleton() {
  return (
    <div aria-busy="true" aria-label="Opening this page" className="space-y-4">
      <div className="h-8 w-2/3 max-w-sm animate-pulse rounded-xl bg-[var(--swift-subtle)] motion-reduce:animate-none" />
      <div className="h-28 animate-pulse rounded-2xl bg-[var(--swift-subtle)] motion-reduce:animate-none" />
      <div className="h-28 animate-pulse rounded-2xl bg-[var(--swift-subtle)] motion-reduce:animate-none" />
    </div>
  );
}
