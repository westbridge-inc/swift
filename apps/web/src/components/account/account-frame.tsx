'use client';

import { Fragment, type ReactNode } from 'react';
import { useCustomerSession } from '@/components/customer-session';
import { SignInDoor } from '@/components/customer-shell';

export const fieldClass = 'sw-input';
export const buttonClass = 'sw-btn sw-btn-md';
export const secondaryClass = 'sw-btn sw-btn-md sw-btn-outline';

export function AccountBoundary({ children, path = '/account' }: { children: ReactNode; path?: string }) {
  const session = useCustomerSession();
  if (session.status === 'checking') return <p role="status">Checking your account…</p>;
  if (session.status !== 'signed-in') return <SignInDoor door={{ title: 'Sign in to your account', body: 'Sign in to see your orders, addresses and favourites.' }} returnPath={path} />;
  // Remount forms as well as reads: a late response or draft belongs to one person.
  return <Fragment key={`${session.scope}:${session.epoch}`}>{children}</Fragment>;
}

export function AccountFrame({ title, children }: { title: string; children: ReactNode }) {
  // [WEB-REDESIGN] The shell's back button returns to Account; the page is
  // the design's narrow column: an eyebrow, the title, then the content.
  return <div className="mx-auto flex max-w-[720px] flex-col gap-5">
    <div><span className="sw-eyebrow">Account</span><h1 className="sw-title mt-1">{title}</h1></div>
    {children}
  </div>;
}

export { useAccountQuery } from './account-query';
