'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, LogOut, Menu, RefreshCw, X, type LucideIcon } from 'lucide-react';
import { SignOutButton } from '@/components/sign-out-button';
import { Avatar, SwitchAppSheet, type ShellPerson } from '@/components/customer-shell';
import { SwiftLogo } from '@/components/swift-logo';

export type ConsoleNavItem = { href: string; label: string; icon: LucideIcon; exact: boolean; dock?: boolean };
type Props = {
  children: React.ReactNode; home: string; title: string; description?: string;
  navigation: readonly ConsoleNavItem[]; signOutBody: string; switcher?: React.ReactNode; contentKey?: string; person?: ShellPerson | null;
};

/** Role-specific chrome. Route owners retain session and store authority. */
export function ConsoleShell({ children, home, title, description, navigation, signOutBody, switcher, contentKey, person }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [switchApp, setSwitchApp] = useState(false);
  const name = person?.name || 'Your account';
  const closeButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const role = home === '/dashboard' ? 'vendor' : home === '/portal' ? 'driver' : 'advertiser';
  const account = navigation.find(n => /\/(settings|account)$/.test(n.href))?.href ?? home;
  const activeHref = [...navigation].filter(item => item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const active = (item: ConsoleNavItem) => item.href === activeHref;
  useEffect(() => { setOpen(false); setSwitchApp(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  const close = () => { setOpen(false); menuButton.current?.focus(); };
  const switchButton = <button type="button" onClick={() => { setOpen(false); setSwitchApp(true); }} aria-haspopup="dialog"
    className="flex w-full items-center gap-3 rounded-2xl bg-[var(--swift-red)] p-3 text-left text-white hover:bg-[var(--swift-red-600)]">
    <span className="grid h-9 w-9 place-items-center rounded-full bg-white/15"><RefreshCw size={18} aria-hidden /></span>
    <span><span className="block sw-label text-white">Switch app</span><span className="text-[13px]">Swift {title}</span></span>
  </button>;
  const navigationContent = (mobile: boolean) => <>
    <Link href={home} className="flex items-center gap-2 px-2"><SwiftLogo /><span className="sw-caption">{title}</span></Link>
    {description && <p className="sw-caption mt-3 px-2">{description}</p>}
    {switcher && <div className="mt-5">{switcher}</div>}
    <nav aria-label={`${title} navigation`} className="mt-6 flex-1 space-y-0.5">
      {navigation.map(item => <Link key={item.href} href={item.href} onClick={mobile ? close : undefined} aria-current={active(item) ? 'page' : undefined}
        className={`flex min-h-11 items-center gap-3 rounded-xl px-2.5 text-[15px] hover:bg-[var(--swift-sunken)] ${active(item) ? 'font-semibold text-[var(--swift-ink)]' : 'font-medium text-[var(--swift-muted)]'}`}>
        <item.icon size={24} className={active(item) ? 'text-[var(--swift-red)]' : ''} aria-hidden />{item.label}
      </Link>)}
    </nav>
    <div className="mt-6 space-y-5">{switchButton}
      <Link href={account} className="flex items-center gap-3 rounded-xl p-1.5"><Avatar name={name} /><span className="sw-label truncate">{name}</span></Link>
      <SignOutButton className="sw-link-btn flex min-h-11 items-center gap-2 px-2" body={signOutBody} redirectTo="/login"><LogOut size={16} aria-hidden />Sign out</SignOutButton>
    </div>
  </>;
  return <div className="swift-console min-h-dvh min-w-0 bg-[var(--swift-canvas)] text-[var(--swift-ink)] wide:flex">
    <aside className="hidden wide:sticky wide:top-0 wide:flex wide:h-dvh wide:w-[280px] wide:flex-none wide:flex-col wide:overflow-y-auto wide:border-r wide:border-[var(--swift-border)] wide:bg-[var(--swift-card)] wide:px-4 wide:py-6">{navigationContent(false)}</aside>
    <div className="min-w-0 flex-1">
      <header className="flex min-h-16 items-center gap-3 px-6 pt-[env(safe-area-inset-top)] wide:px-10">
        <button ref={menuButton} type="button" aria-label="Open menu" aria-expanded={open} aria-controls="console-menu" onClick={() => setOpen(true)} className="sw-icon-btn wide:hidden"><Menu size={20} aria-hidden /></button>
        <Link href={home} className="sw-label wide:hidden">Swift {title}</Link>
        <div className="flex-1" />
        <Link href={`${home}/notifications`} aria-label="Notifications" className="sw-icon-btn"><Bell size={20} aria-hidden /></Link>
      </header>
      {open && <div id="console-menu" role="dialog" aria-modal="true" aria-label={`${title} menu`} onKeyDown={e => { if (e.key === 'Escape') close(); }} className="fixed inset-0 z-50 wide:hidden">
        <button type="button" tabIndex={-1} aria-label="Close menu" onClick={close} className="absolute inset-0 bg-[var(--swift-scrim)]" />
        <aside className="absolute inset-y-0 left-0 flex w-[min(20rem,calc(100vw-3rem))] flex-col overflow-y-auto bg-[var(--swift-card)] p-4">
          <button ref={closeButton} type="button" onClick={close} aria-label="Close" className="sw-icon-btn mb-4 self-end"><X size={20} aria-hidden /></button>
          {navigationContent(true)}
        </aside>
      </div>}
      <main key={contentKey} className="sw-page sw-partner pb-6">{children}</main>
      <footer className="sw-caption px-6 pb-[calc(88px_+_env(safe-area-inset-bottom))] pt-6 wide:px-10 wide:pb-8">Prices in GYD</footer>
    </div>
    <nav aria-label={`${title} tabs`} className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--swift-border)] bg-[var(--swift-card)] pb-[env(safe-area-inset-bottom)] wide:hidden">
      <ul className="mx-auto flex h-[60px] max-w-lg">{navigation.filter(n => n.dock !== false).map(item => <li key={item.href} className="min-w-0 flex-1">
        <Link href={item.href} aria-current={active(item) ? 'page' : undefined} className={`flex h-full flex-col items-center justify-center gap-0.5 text-[11px] ${active(item) ? 'font-semibold text-[var(--swift-red)]' : 'font-medium text-[var(--swift-muted)]'}`}>
          <item.icon size={24} aria-hidden /><span>{item.label}</span>
        </Link>
      </li>)}</ul>
    </nav>
    {switchApp && <SwitchAppSheet current={role} onClose={() => setSwitchApp(false)} />}
  </div>;
}
