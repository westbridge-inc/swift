'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Menu, X, type LucideIcon } from 'lucide-react';
import { SignOutButton } from '@/components/sign-out-button';

export type ConsoleNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact: boolean;
};

type Props = {
  children: React.ReactNode;
  home: string;
  title: string;
  description?: string;
  navigation: readonly ConsoleNavItem[];
  signOutBody: string;
  switcher?: React.ReactNode;
  contentKey?: string;
};

/** Shared chrome for the store and earner consoles; route data stays in each owner. */
export function ConsoleShell({ children, home, title, description, navigation, signOutBody, switcher, contentKey }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  const close = () => { setOpen(false); menuButton.current?.focus(); };

  const navigationContent = (mobile: boolean) => (
    <>
      <Link href={home} onClick={mobile ? close : undefined} className="px-2 text-lg font-extrabold tracking-tight">
        <span className="text-[var(--swift-red)]">Swift</span> {title}
      </Link>
      {description && <p className="mt-1 px-2 text-xs text-[var(--swift-muted)]">{description}</p>}
      {switcher && <div className="mt-4">{switcher}</div>}
      <nav aria-label={`${title} navigation`} className="mt-4 flex-1 space-y-1">
        {navigation.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} onClick={mobile ? close : undefined}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${active
                ? 'bg-[var(--swift-red)]/10 text-[var(--swift-red)]'
                : 'text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] hover:text-[var(--swift-ink)]'}`}>
              <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />{item.label}
            </Link>
          );
        })}
      </nav>
      <SignOutButton
        className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)] hover:text-[var(--swift-ink)]"
        body={signOutBody} redirectTo="/login">
        <LogOut className="h-4 w-4" aria-hidden="true" />Sign out
      </SignOutButton>
    </>
  );

  return (
    <div className="swift-console min-h-screen min-w-0 bg-[var(--swift-subtle)]">
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col overflow-y-auto border-r border-black/5 bg-white p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] pb-[calc(env(safe-area-inset-bottom)_+_1rem)] lg:flex">
        {navigationContent(false)}
      </aside>
      <header className="sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-black/5 bg-white px-4 pt-[env(safe-area-inset-top)] lg:hidden">
        <button ref={menuButton} type="button" aria-label="Open menu" aria-expanded={open} aria-controls="console-menu"
          onClick={() => setOpen(true)} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg hover:bg-[var(--swift-subtle)]">
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <Link href={home} className="min-w-0 truncate text-lg font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> {title}
        </Link>
      </header>
      {open && (
        <div id="console-menu" role="dialog" aria-modal="true" aria-label={`${title} menu`}
          onKeyDown={(event) => { if (event.key === 'Escape') close(); }}
          className="fixed inset-0 z-50 lg:hidden">
          <button type="button" tabIndex={-1} aria-label="Close menu" onClick={close}
            className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 left-0 flex w-[min(20rem,calc(100vw-3rem))] flex-col overflow-y-auto border-r border-black/5 bg-white p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] pb-[calc(env(safe-area-inset-bottom)_+_1rem)] shadow-xl">
            <div className="mb-3 flex items-center justify-end">
              <button ref={closeButton} type="button" onClick={close} aria-label="Close"
                className="grid h-11 w-11 place-items-center rounded-lg hover:bg-[var(--swift-subtle)]">
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            {navigationContent(true)}
          </aside>
        </div>
      )}
      <main key={contentKey} className="min-w-0 p-4 pb-[calc(env(safe-area-inset-bottom)_+_1rem)] sm:p-6 lg:ml-60 lg:p-8">
        {children}
      </main>
    </div>
  );
}
