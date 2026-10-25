/**
 * [O-1 · owner 24 Oct 2026] CALL_RELAY: the Swift call bridge's switch.
 *
 * OFF by default, and it ships OFF. It is turned on only after a real Swift
 * test call rings and "Press 1" connects on a Digicel phone AND a GTT phone.
 *
 * While it is OFF nothing about phone numbers changes for anyone (owner,
 * 24 Oct 06:00Z): every app, old store build or new, keeps the other party's
 * number on a live order exactly as today, so no one is left with no way to
 * call at the door. In-app chat works either way.
 */

export const CALL_RELAY_ENV = 'CALL_RELAY';

/** On only when exactly "1" (surrounding blanks ignored); anything else is off. */
export function callRelayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env[CALL_RELAY_ENV] ?? '').trim() === '1';
}
