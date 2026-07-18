import Link from 'next/link';

/** Shared marketing chrome: nav + footer, Swift red on a light canvas. */

const NAV = [
  { href: '/stores', label: 'Stores' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/for-vendors', label: 'For businesses' },
  { href: '/for-drivers', label: 'For drivers' },
  { href: '/pricing', label: 'Pricing' },
];

export function SiteNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-black/5 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Link href="/" className="text-xl font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span>
        </Link>
        <nav className="hidden gap-7 text-sm font-medium text-[var(--swift-muted)] md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="transition-colors hover:text-[var(--swift-ink)]">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <Link
            href="/login?next=/order"
            className="text-sm font-semibold text-[var(--swift-muted)] transition-colors hover:text-[var(--swift-ink)]"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-[var(--swift-red)] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--swift-red-600)]"
          >
            Join Swift
          </Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-black/5 bg-[var(--swift-subtle)]">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-lg font-extrabold">
            <span className="text-[var(--swift-red)]">Swift</span>
          </p>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            One app for food, groceries, shops, couriers and rides — built for the Caribbean.
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[var(--swift-muted)]">
          <Link href="/about" className="hover:text-[var(--swift-ink)]">About</Link>
          <Link href="/contact" className="hover:text-[var(--swift-ink)]">Contact</Link>
          <Link href="/legal/terms" className="hover:text-[var(--swift-ink)]">Terms</Link>
          <Link href="/legal/privacy" className="hover:text-[var(--swift-ink)]">Privacy</Link>
        </nav>
      </div>
      <div className="border-t border-black/5 py-4 text-center text-xs text-[var(--swift-muted)]">
        © {new Date().getFullYear()} Westbridge Inc. All rights reserved.
      </div>
    </footer>
  );
}

/** Section shell with the marketing rhythm baked in. */
export function Section({ children, tint = false }: { children: React.ReactNode; tint?: boolean }) {
  return (
    <section className={tint ? 'bg-[var(--swift-subtle)]' : ''}>
      <div className="mx-auto max-w-6xl px-5 py-16 md:py-20">{children}</div>
    </section>
  );
}
