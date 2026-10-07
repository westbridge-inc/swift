'use client';

import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { Modal } from '@/components/modal';
import Link from 'next/link';
import { Check, ChevronLeft, Menu, RefreshCw, X } from 'lucide-react';
import { SwiftLogo } from '@/components/swift-logo';
import { Pictogram, TabGlyph, type PictogramName, type TabGlyphName } from '@/components/glyphs';
import { LoadingRegion } from '@/components/customer-skeletons';
import type { SessionStatus } from '@/components/customer-session';
import { signInPath, signUpPath, type CustomerTab, type SignInDoor as SignInDoorCopy } from '@/lib/customer-routes';

/**
 * [Q7b · WEB-REDESIGN] The chrome of the customer app — the parts that stay
 * put while pages change underneath them. The shell (app/(app)/layout.tsx)
 * owns the state; these only draw it, in the owner's design (4 Oct 2026):
 *
 *   - below 760 px, the phone layout: paper page, the dock at the bottom
 *     (Home · Market · Cart · Profile, with the cart count);
 *   - from 760 px, a white side rail: the mark, the same four places, the
 *     "Switch app" card and the signed-in person at the foot.
 *
 * Tabs, names and order are the phone app's HomeTabs. Market is shown only
 * when the server's depth verdict says so.
 */

/** Press feedback for anything tappable in the app: a small give under the
 *  finger, and none at all for people who asked for less motion. */
export const PRESS =
  'transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100';

interface TabLink {
  tab: CustomerTab;
  href: string;
  label: string;
  glyph: TabGlyphName;
}

const TABS: TabLink[] = [
  { tab: 'home', href: '/', label: 'Home', glyph: 'home' },
  { tab: 'market', href: '/market', label: 'Market', glyph: 'market' },
  { tab: 'cart', href: '/cart', label: 'Cart', glyph: 'cart' },
  { tab: 'profile', href: '/account', label: 'Profile', glyph: 'profile' },
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

export const MORE_LINKS = [
  ...BUSINESS_LINKS,
  { href: '/welcome', label: 'Why Swift' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing for businesses' },
  { href: '/faq', label: 'Questions' },
  { href: '/contact', label: 'Contact' },
] as const;

/** The cart count the rail and the dock show: what is in the cart, or nothing. */
export function cartBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

/** Who is signed in, for the rail's foot. */
export interface ShellPerson {
  name: string;
  phone: string | null;
}

// ── In-page back buttons ────────────────────────────────────────────────────
// The shell knows where "back" goes (in-app history, else the page's parent).
// Most pages get it as a plain 56 px row above their content; a page whose
// design puts it elsewhere (over a store's photo, beside the search field)
// claims it and draws <BackButton /> itself.
interface ShellNav {
  showBack: boolean;
  goBack: () => void;
  claimBack: () => () => void;
  /** Opens the shell's "Switch app" sheet (the rail's card, Account's "Earn with Swift"). */
  openSwitchApp: () => void;
}

const ShellNavContext = createContext<ShellNav>({ showBack: false, goBack: () => undefined, claimBack: () => () => undefined, openSwitchApp: () => undefined });

export function useSwitchApp(): () => void {
  return useContext(ShellNavContext).openSwitchApp;
}
export const ShellNavProvider = ShellNavContext.Provider;

/**
 * For a page that draws its own back button where its design puts it. Pass
 * `false` while the page is in a state that does not draw it (loading, an
 * error, empty): the shell's own Back row stays until the page's does.
 */
export function useOwnBackButton(drawn = true): void {
  const { claimBack } = useContext(ShellNavContext);
  useLayoutEffect(() => (drawn ? claimBack() : undefined), [claimBack, drawn]);
}

export function BackButton({ className = '' }: { className?: string }) {
  const { showBack, goBack } = useContext(ShellNavContext);
  if (!showBack) return null;
  return (
    <button type="button" onClick={goBack} aria-label="Back" className={`sw-icon-btn ${className}`}>
      <ChevronLeft size={20} aria-hidden />
    </button>
  );
}

export function BackRow() {
  return (
    <div className="flex h-14 items-center">
      <BackButton />
    </div>
  );
}

// ── The side rail (≥ 760 px) ────────────────────────────────────────────────

export function SideRail({
  activeTab,
  marketVisible,
  cartCount,
  status,
  person,
  returnPath,
  onSwitchApp,
}: {
  activeTab: CustomerTab;
  marketVisible: boolean;
  cartCount: number;
  status: SessionStatus;
  person: ShellPerson | null;
  returnPath: () => string;
  onSwitchApp: () => void;
}) {
  const badge = cartBadge(cartCount);
  return (
    <header className="hidden wide:sticky wide:top-0 wide:flex wide:h-dvh wide:w-[280px] wide:flex-none wide:flex-col wide:gap-6 wide:overflow-y-auto wide:border-r wide:border-[var(--swift-border)] wide:bg-[var(--swift-card)] wide:px-4 wide:pb-5 wide:pt-[calc(24px_+_env(safe-area-inset-top))]">
      <Link href="/" aria-label="Swift home" className="flex items-center gap-1.5 self-start px-2">
        <SwiftLogo />
      </Link>

      <nav aria-label="Swift sections" className="flex flex-col gap-0.5">
        {visibleTabs(marketVisible).map(({ tab, href, label, glyph }) => {
          const on = activeTab === tab;
          return (
            <Link
              key={tab}
              href={href}
              prefetch={true}
              aria-current={on ? 'page' : undefined}
              className={`flex h-11 items-center gap-3 rounded-xl px-2.5 text-[15px] leading-5 transition-colors hover:bg-[var(--swift-sunken)] ${on ? 'font-semibold text-[var(--swift-ink)]' : 'font-medium text-[var(--swift-muted)]'}`}
            >
              <span className={on ? 'text-[var(--swift-red)]' : 'text-[var(--swift-muted)]'}><TabGlyph name={glyph} on={on} size={24} /></span>
              <span className="flex-1">{label}</span>
              {tab === 'cart' && badge ? <span className="sw-badge" aria-label={`${badge} in your cart`}>{badge}</span> : null}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <nav aria-label="Swift for business">
        <ul className="flex flex-wrap gap-x-3 px-2.5 text-[13px] leading-[18px] text-[var(--swift-muted)]">
          {BUSINESS_LINKS.map((link) => (
            <li key={link.href}><Link href={link.href} className="inline-flex min-h-8 min-w-0 items-center hover:text-[var(--swift-ink)]">{link.label}</Link></li>
          ))}
        </ul>
      </nav>

      <button
        type="button"
        onClick={onSwitchApp}
        aria-haspopup="dialog"
        className="flex items-center gap-3 rounded-2xl bg-[var(--swift-red)] p-3 text-left text-[var(--swift-white)] transition-colors hover:bg-[var(--swift-red-600)]"
      >
        <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-[var(--swift-on-brand-muted)]"><RefreshCw size={18} aria-hidden /></span>
        <span className="flex flex-1 flex-col">
          <span className="text-[15px] font-semibold leading-5">Switch app</span>
          <span className="text-[13px] leading-[18px] opacity-90">Swift</span>
        </span>
      </button>

      <RailAccount status={status} person={person} returnPath={returnPath} />
    </header>
  );
}

function initial(name: string | null | undefined): string {
  return (name ?? '').trim().charAt(0).toUpperCase() || 'S';
}

export function Avatar({ name, size = 40 }: { name: string | null | undefined; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid flex-none place-items-center rounded-full bg-[var(--swift-red-50)] font-bold text-[var(--swift-red)]"
      style={{ width: size, height: size, fontSize: size >= 56 ? 22 : 15 }}
    >
      {initial(name)}
    </span>
  );
}

function RailAccount({ status, person, returnPath }: { status: SessionStatus; person: ShellPerson | null; returnPath: () => string }) {
  if (status === 'checking') return <span aria-hidden className="block h-[52px]" />;
  if (status === 'guest') {
    return (
      <div className="flex flex-col gap-1">
        <Link href={signInPath(returnPath())} className="sw-btn sw-btn-md sw-btn-outline">Sign in</Link>
        <Link href={signUpPath(returnPath())} className="sw-link-btn self-center py-2">Create an account</Link>
      </div>
    );
  }
  return (
    <Link href="/account" className="flex items-center gap-2.5 rounded-xl p-1.5 text-[var(--swift-ink)] hover:bg-[var(--swift-sunken)]">
      <Avatar name={person?.name} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[15px] font-semibold leading-5">{person?.name || 'Your account'}</span>
        {person?.phone ? <span className="truncate text-[13px] leading-[18px] text-[var(--swift-muted)]">{person.phone}</span> : null}
      </span>
    </Link>
  );
}

// ── The dock (< 760 px) ─────────────────────────────────────────────────────

/** The phone app's dock: Home · Market · Cart · Profile, phone widths only. */
export function TabBar({ activeTab, marketVisible, cartCount }: { activeTab: CustomerTab; marketVisible: boolean; cartCount: number }) {
  const badge = cartBadge(cartCount);
  return (
    <nav
      aria-label="Swift tabs"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--swift-border)] bg-[var(--swift-card)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] wide:hidden"
    >
      <ul className="mx-auto flex h-[60px] max-w-md">
        {visibleTabs(marketVisible).map(({ tab, href, label, glyph }) => {
          const active = activeTab === tab;
          return (
            <li key={tab} className="flex-1">
              <Link
                href={href}
                prefetch={true}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-full flex-col items-center justify-center gap-0.5 text-[11px] leading-[14px] ${PRESS} ${
                  active ? 'font-semibold text-[var(--swift-red)]' : 'font-medium text-[var(--swift-muted-soft)]'
                }`}
              >
                <TabGlyph name={glyph} on={active} size={25} />
                <span>{label}</span>
                {tab === 'cart' && badge ? (
                  <span className="sw-badge absolute left-[calc(50%_+_6px)] top-1.5 h-[18px] min-w-[18px] px-[5px] shadow-[0_0_0_2px_var(--swift-card)]" aria-label={`${badge} in your cart`}>{badge}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal label={label} onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-3">
      <span aria-hidden className="mx-auto mb-4 block h-1 w-10 rounded-full bg-[var(--swift-border-strong)] wide:hidden" />
      {children}
    </Modal>
  );
}

const SWITCH_ROLES: { key: string; label: string; sub: string; pictogram: PictogramName; href: string | null }[] = [
  { key: 'customer', label: 'Swift', sub: 'Order food, groceries and parcels', pictogram: 'food', href: null },
  { key: 'driver', label: 'Swift Driver', sub: 'Your earnings and documents — jobs are taken in the Swift app', pictogram: 'wheel', href: '/portal' },
  { key: 'vendor', label: 'Swift Business', sub: 'Your store’s orders and menu', pictogram: 'shops', href: '/dashboard' },
  { key: 'ads', label: 'Swift Ads', sub: 'Advertising is managed in the Swift app', pictogram: 'scan', href: null },
];

/** "Switch app": one account, the other Swift apps it can open on the web. */
export function SwitchAppSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="Switch app" onClose={onClose}>
      <>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <h2 className="sw-title">Switch app</h2>
              <p className="sw-caption mt-0.5">One account — choose how you’re using Swift right now.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" data-modal-initial-focus className="sw-icon-btn"><X size={20} aria-hidden /></button>
          </div>
          <ul className="mt-4">
            {SWITCH_ROLES.map((role) => {
              const current = role.key === 'customer';
              const body = (
                <>
                  <span className={`grid h-12 w-12 flex-none place-items-center rounded-2xl ${current ? 'bg-[var(--swift-red)] text-[var(--swift-white)]' : 'bg-[var(--swift-sunken)] text-[var(--swift-ink)]'}`}>
                    <Pictogram name={role.pictogram} size={24} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="sw-label">{role.label}</span>
                    <span className="sw-caption">{role.sub}</span>
                  </span>
                  {current ? <Check size={18} className="text-[var(--swift-red)]" aria-label="You are here" /> : null}
                </>
              );
              return (
                <li key={role.key}>
                  {role.href ? (
                    <Link href={role.href} onClick={onClose} className="sw-row py-3">{body}</Link>
                  ) : current ? (
                    <button type="button" onClick={onClose} aria-current="true" className="sw-row cursor-pointer py-3">{body}</button>
                  ) : (
                    <div className="sw-row py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
      </>
    </Sheet>
  );
}

/** Phone widths: the company pages, sign-in, and a way back out. */
export function MoreMenu({ guest, returnPath, onClose }: { guest: boolean; returnPath: () => string; onClose: () => void }) {
  return (
    <Sheet label="More from Swift" onClose={onClose}>
      <>
          <div className="flex items-center justify-between">
            <SwiftLogo />
            <button type="button" onClick={onClose} aria-label="Close" data-modal-initial-focus className="sw-icon-btn"><X size={20} aria-hidden /></button>
          </div>
          <ul className="mt-3">
            {MORE_LINKS.map((link) => (
              <li key={link.href}><Link href={link.href} onClick={onClose} className="sw-row sw-label">{link.label}</Link></li>
            ))}
          </ul>
          {guest ? (
            <div className="mt-5 grid gap-2">
              <Link href={signInPath(returnPath())} onClick={onClose} className="sw-btn sw-btn-block">Sign in</Link>
              <Link href={signUpPath(returnPath())} onClick={onClose} className="sw-btn sw-btn-block sw-btn-outline">Create an account</Link>
            </div>
          ) : null}
      </>
    </Sheet>
  );
}

/** The "More from Swift" control a page header carries on phone widths. */
export function MoreButton({ onOpen, open }: { onOpen: () => void; open: boolean }) {
  return (
    <button type="button" onClick={onOpen} aria-label="More from Swift" aria-haspopup="dialog" aria-expanded={open} className="sw-icon-btn sw-icon-btn-bare">
      <Menu size={22} aria-hidden />
    </button>
  );
}

/** A private page, opened by a guest: say what it is for and offer sign-in,
 *  inside the app — the tabs stay, like the phone app's guest screens. */
export function SignInDoor({ door, returnPath }: { door: SignInDoorCopy; returnPath: string }) {
  return (
    <section aria-labelledby="sign-in-door-title" className="sw-empty sw-in mx-auto max-w-[400px]">
      <span className="sw-empty-tile"><TabGlyph name="profile" on={false} size={40} /></span>
      <h1 id="sign-in-door-title" className="sw-heading">{door.title}</h1>
      <p className="sw-caption max-w-[340px] text-[15px] leading-[22px]">{door.body}</p>
      <div className="mt-4 grid w-full gap-2">
        <Link href={signInPath(returnPath)} className="sw-btn sw-btn-block">Sign in</Link>
        <Link href={signUpPath(returnPath)} className="sw-btn sw-btn-block sw-btn-outline">Create an account</Link>
        <Link href="/" className="sw-link-btn mt-1 py-2 text-center">Keep browsing</Link>
      </div>
    </section>
  );
}

/** What a private page shows while its sign-in answer is on the way: the
 *  shape of a page, inside the chrome — never a blank screen. */
export function ContentSkeleton() {
  return (
    <LoadingRegion label="Opening this page" className="space-y-4 pt-2">
      <span className="sw-skeleton h-7 w-2/3 max-w-sm" />
      <span className="sw-skeleton h-28 rounded-2xl" />
      <span className="sw-skeleton h-28 rounded-2xl" />
    </LoadingRegion>
  );
}
