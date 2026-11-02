'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { SwiftLogo } from '@/components/swift-logo';

export { CODE_NOT_SEEN_HINT, DIAL_CODE, PhoneField, fullPhone, phoneReady } from '@/components/phone-field';

/**
 * [WEB-REDESIGN] Sign-in in the owner's design: the mark at the top of a
 * paper page, a small eyebrow, one question in Bricolage, and the +592 chip
 * beside the number. Shared by sign-in and account creation, so the two read
 * as one flow.
 */


export function AuthPage({ children, onBrandClick }: { children: ReactNode; onBrandClick?: () => void }) {
  return (
    <main id="main" tabIndex={-1} className="flex min-h-dvh justify-center bg-[var(--swift-canvas)] px-6 pb-10 pt-8 wide:px-10 wide:pt-24">
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


/** Six boxes over one real input: typing, pasting and the phone's one-time
 *  code suggestion all land in the input; the boxes only draw it. While the
 *  input has focus, the box where the next digit lands (the last one once all
 *  six are in) carries the focus ring, so keyboard focus is always visible. */
export function CodeBoxes({ id, value, onChange, onEnter }: { id: string; value: string; onChange: (_value: string) => void; onEnter?: () => void }) {
  const [focused, setFocused] = useState(false);
  const caret = Math.min(value.length, 5);
  return (
    <div className="relative grid grid-cols-6 gap-2">
      {Array.from({ length: 6 }, (_, index) => {
        const current = focused && index === caret;
        return (
          <span
            key={index}
            aria-hidden="true"
            data-code-box={current ? 'focused' : 'idle'}
            className={`grid h-[60px] place-items-center rounded-xl bg-[var(--swift-card)] font-display text-[34px] font-bold leading-[38px] tabular-nums ${current ? 'border-2 border-[var(--swift-red)] shadow-[0_0_0_3px_var(--swift-red-50)]' : 'border border-[var(--swift-border)]'}`}
          >
            {value[index] ?? ''}
          </span>
        );
      })}
      <label htmlFor={id} className="sr-only">Verification code</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        value={value}
        maxLength={6}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
