'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { SwiftLogo } from './swift-logo';

const NAV = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/vendors', label: 'For businesses' },
  { href: '/drivers', label: 'For drivers' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/faq', label: 'Questions' },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) closeButton.current?.focus(); }, [open]);
  const close = () => { setOpen(false); menuButton.current?.focus(); };

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--swift-border)] bg-white/95 pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-2 px-5">
        <Link href="/" aria-label="Swift home"><SwiftLogo /></Link>
        <nav aria-label="Main" className="hidden gap-7 text-sm font-medium text-[var(--swift-muted)] md:flex">
          {NAV.map((n) => <Link key={n.href} href={n.href} className="transition-colors hover:text-[var(--swift-ink)]">{n.label}</Link>)}
        </nav>
        <div className="flex items-center gap-2 sm:gap-4">
          <Link href="/login?next=/" className="hidden text-sm font-semibold text-[var(--swift-muted)] transition-colors hover:text-[var(--swift-ink)] sm:inline-flex">Sign in</Link>
          <Link href="/signup" className="inline-flex min-h-11 items-center rounded-full bg-[var(--swift-red)] px-4 text-sm font-semibold text-[var(--swift-white)] transition-colors hover:bg-[var(--swift-red-600)] sm:px-5">Join Swift</Link>
          <button ref={menuButton} type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}
            className="grid h-11 w-11 place-items-center rounded-full text-[var(--swift-ink)] md:hidden">
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Swift site menu" onKeyDown={(event) => { if (event.key === 'Escape') close(); }}
          className="fixed inset-0 z-50 md:hidden">
          <button type="button" aria-label="Close menu" tabIndex={-1} onClick={close} className="absolute inset-0 bg-[var(--swift-scrim)]" />
          <div className="absolute inset-x-0 top-0 max-h-full overflow-y-auto overscroll-contain rounded-b-3xl bg-[var(--swift-card)] px-5 pb-6 pt-[calc(env(safe-area-inset-top)_+_0.5rem)] shadow-xl">
            <div className="flex min-h-12 items-center justify-between">
              <SwiftLogo />
              <button ref={closeButton} type="button" onClick={close} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full">
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <nav aria-label="Mobile main" className="mt-2 divide-y divide-black/10">
              {NAV.map((n) => <Link key={n.href} href={n.href} onClick={close} className="flex min-h-11 items-center py-3 text-base font-semibold">{n.label}</Link>)}
            </nav>
            <Link href="/login?next=/" onClick={close} className="mt-3 flex min-h-11 items-center font-semibold sm:hidden">Sign in</Link>
          </div>
        </div>
      )}
    </header>
  );
}
