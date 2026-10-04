'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { SwiftLogo } from '@/components/swift-logo';

/**
 * [WEB-REDESIGN] Sign-in in the owner's design: the mark at the top of a
 * paper page, a small eyebrow, one question in Bricolage, and the +592 chip
 * beside the number. Shared by sign-in and account creation, so the two read
 * as one flow.
 */

export const DIAL_CODE = '+592';

/**
 * The number the server is sent. The field holds the local number; a number
 * typed or pasted with its country code ("+592 600 1234", "5926001234") is
 * read as the same number, never as +592592….
 */
export function fullPhone(local: string): string {
  const digits = local.replace(/\D/g, '');
  if (digits.startsWith('592') && digits.length > 7) return `+${digits}`;
  return `${DIAL_CODE}${digits}`;
}

/** Enough digits to be a Guyana number (seven after +592). */
export function phoneReady(local: string): boolean {
  return fullPhone(local).replace(/\D/g, '').length >= 10;
}

export function AuthPage({ children, onBrandClick }: { children: ReactNode; onBrandClick?: () => void }) {
  return (
    <main className="flex min-h-dvh justify-center bg-[var(--swift-canvas)] px-6 pb-10 pt-8 wide:px-10 wide:pt-24">
      <div className="flex w-full max-w-[420px] flex-col gap-6 sw-in">
        <Link href="/" aria-label="Swift home" onClick={onBrandClick} className="flex items-center gap-1.5 self-start">
          <SwiftLogo />
        </Link>
        {children}
      </div>
    </main>
  );
}

export function AuthHeading({ eyebrow, title, id, children }: { eyebrow: string; title: string; id?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="sw-eyebrow">{eyebrow}</span>
      <h1 id={id} className="sw-title">{title}</h1>
      {children ? <div className="sw-caption">{children}</div> : null}
    </div>
  );
}

export function PhoneField({ id, value, onChange, onEnter, autoFocus = false }: { id: string; value: string; onChange: (_value: string) => void; onEnter?: () => void; autoFocus?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="flex h-14 flex-none items-center rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 text-base font-semibold" aria-hidden="true">{DIAL_CODE}</span>
      <label htmlFor={id} className="sr-only">Phone number</label>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9+ ]/g, '').slice(0, 16))}
        onKeyDown={(event) => { if (event.key === 'Enter') onEnter?.(); }}
        placeholder="600 1234"
        className="sw-input h-14 flex-1 rounded-2xl"
      />
    </div>
  );
}

/** Six boxes over one real input: typing, pasting and the phone's one-time
 *  code suggestion all land in the input; the boxes only draw it. */
export function CodeBoxes({ id, value, onChange, onEnter }: { id: string; value: string; onChange: (_value: string) => void; onEnter?: () => void }) {
  return (
    <div className="relative grid grid-cols-6 gap-2">
      {Array.from({ length: 6 }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={`grid h-[60px] place-items-center rounded-xl bg-[var(--swift-card)] font-display text-[34px] font-bold leading-[38px] tabular-nums ${index === value.length ? 'border-2 border-[var(--swift-red)]' : 'border border-[var(--swift-border)]'}`}
        >
          {value[index] ?? ''}
        </span>
      ))}
      <label htmlFor={id} className="sr-only">Verification code</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        value={value}
        maxLength={6}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(event) => { if (event.key === 'Enter') onEnter?.(); }}
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
        style={{ fontSize: 16 }}
      />
    </div>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return <p className="sw-note sw-note-error" role="alert" aria-live="assertive">{children}</p>;
}
