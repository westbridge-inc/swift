'use client';

import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useCustomerSession } from '@/components/customer-session';
import { SignInDoor } from '@/components/customer-shell';

export const fieldClass = 'w-full rounded-xl border border-black/15 bg-white px-3 py-3';
export const buttonClass = 'min-h-11 rounded-full bg-[var(--swift-red)] px-5 py-3 font-bold text-white disabled:opacity-50';
export const secondaryClass = 'min-h-11 rounded-xl border border-black/15 px-4 py-2 font-semibold disabled:opacity-50';

export function AccountBoundary({ children, path = '/account' }: { children: ReactNode; path?: string }) {
  const session = useCustomerSession();
  if (session.status === 'checking') return <p role="status">Checking your account…</p>;
  if (session.status !== 'signed-in') return <SignInDoor door={{ title: 'Sign in to your account', body: 'Sign in to see your orders, addresses and favourites.' }} returnPath={path} />;
  // Remount forms as well as reads: a late response or draft belongs to one person.
  return <Fragment key={`${session.scope}:${session.epoch}`}>{children}</Fragment>;
}

export function AccountFrame({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mx-auto max-w-lg space-y-5">
    <Link href="/account" className="inline-block py-2 text-sm font-semibold text-[var(--swift-red)]">Back to account</Link>
    <h1 className="text-2xl font-extrabold">{title}</h1>
    {children}
  </div>;
}

export function useAccountQuery<T>(name: string, read: () => Promise<T>) {
  const session = useCustomerSession();
  return useQuery({ queryKey: ['account', session.scope, session.epoch, name], queryFn: read,
    enabled: session.status === 'signed-in', retry: false, staleTime: name === 'favourites' ? 30_000 : 0, gcTime: name === 'favourites' ? 5 * 60_000 : 0 });
}
