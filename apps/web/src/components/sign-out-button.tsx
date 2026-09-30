'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { logout } from '@/lib/auth';

/**
 * THE ONE "SIGN OUT?" ASK on the web, the twin of the app's shared log-out
 * confirm (apps/mobile/src/kit/logout-confirm.tsx). The sign-out control opens
 * it in its own place, the way the order-cancel and clear-cart confirms do, and
 * only "Sign out" inside it ends the session:
 *
 *  - The teardown is lib/auth's logout(): the server revokes the session and
 *    expires both cookies, then the page leaves. Nothing is re-expressed.
 *  - "Stay signed in" and Escape close it and do nothing else; focus goes back
 *    to the control.
 *  - "Sign out" runs once, however often it is clicked.
 *  - Focus starts on "Stay signed in", so a second Enter does not sign out.
 *    The ask's bottom row is "Stay signed in" too: in the sidebars the ask
 *    grows up from the control's place, so a double-click there lands on it.
 */
export function SignOutButton({
  className,
  children,
  body,
  title = 'Sign out of Swift?',
  redirectTo,
}: {
  /** The control's own look: each surface keeps its button as it was. */
  className: string;
  children: ReactNode;
  /** What signing out costs here, in plain words: what stops and what stays. */
  body: string;
  title?: string;
  /** Where the page goes once the server has ended the session. */
  redirectTo: string;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const signingOut = useRef(false);
  const returnFocus = useRef(false);
  const control = useRef<HTMLButtonElement | null>(null);
  const stay = useRef<HTMLButtonElement | null>(null);
  const id = useId();

  useEffect(() => {
    if (asking) {
      stay.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      control.current?.focus();
    }
  }, [asking]);

  const close = () => {
    if (signingOut.current) return;
    returnFocus.current = true;
    setAsking(false);
  };

  const signOut = () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setLeaving(true);
    // the session lives in a cookie only the server can expire
    void logout().then(() => router.replace(redirectTo));
  };

  if (!asking) {
    return (
      <button ref={control} type="button" aria-haspopup="dialog" onClick={() => setAsking(true)} className={className}>
        {children}
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
      className="rounded-xl border border-black/10 bg-white p-4 text-left"
    >
      <p id={`${id}-title`} className="text-sm font-bold text-[var(--swift-ink)]">{title}</p>
      <p id={`${id}-body`} className="mt-1 text-sm text-[var(--swift-muted)]">{body}</p>
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={signOut}
          disabled={leaving}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50"
        >
          {leaving ? 'Signing out…' : 'Sign out'}
        </button>
        <button
          ref={stay}
          type="button"
          onClick={close}
          disabled={leaving}
          className="rounded-lg border border-black/10 px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Stay signed in
        </button>
      </div>
    </div>
  );
}
