import { guyanaPhone } from '@/lib/guyana-phone';

/**
 * [WEB-REDESIGN · SIGNUP-PHONE perf] The +592 chip beside the local number, on its own so sign-up loads it without the
 * rest of the sign-in kit (auth-ui re-exports it for sign-in).
 */
export const DIAL_CODE = '+592';

/**
 * The number the server is sent. The field holds the local number beside the
 * +592 chip:
 *  - a local number ("600 1234") is sent as +5926001234;
 *  - a number typed or pasted with Guyana's code ("+592 600 1234",
 *    "5926001234") is the same number, never +592592…;
 *  - any other number typed with a leading "+" is sent as typed (digits only),
 *    exactly as sign-in sent it before the redesign.
 */
export function fullPhone(local: string): string {
  const trimmed = local.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') && !digits.startsWith('592')) return `+${digits}`;
  // [SIGNUP-PHONE] A Guyana number, however typed (a trunk 0, "(592)", "00592" too), is the same number sign-up sends.
  return guyanaPhone(trimmed);
}

/** Enough to send: seven digits after +592, or eight after another code. */
export function phoneReady(local: string): boolean {
  const number = fullPhone(local);
  return number.startsWith(DIAL_CODE) ? number.length - DIAL_CODE.length >= 7 : number.replace(/\D/g, '').length >= 8;
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

/** [SIGNUP-PHONE · owner 1 Nov 2026] Under the code box on sign-up and sign-in: where a code that has not shown up went. */
export const CODE_NOT_SEEN_HINT = 'Can’t see the code? It comes from ‘Swift’. Check your Messages filters (Unknown Senders / Transactions) or spam folder.';
