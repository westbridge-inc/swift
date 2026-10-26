/**
 * [O-1 · owner 22-24 Oct 2026] Calling the other person on an order.
 *
 * This app version knows the Swift call bridge, and says so on every request
 * (CALL_BRIDGE_HEADER, sent by services/api.ts). What it does depends on the
 * server's switch, read from GET /calls/config:
 *
 * - Bridge OFF (the launch state): exactly today's behaviour. The server still
 *   sends the other person's number, and "Call" opens the phone's dialler.
 * - Bridge ON: the server sends no personal number. "Call via Swift" asks
 *   Swift to connect the call: Swift rings THIS phone first from Swift's own
 *   number; answer and press 1, then Swift rings the other person.
 * - Neither (no bridge, no number): no Call button; chat and support remain.
 *
 * Pure: no React, no network. The hook and the button live in useCallParty.ts.
 */

export const CALL_BRIDGE_HEADER = 'x-swift-call-bridge';
export const CALL_BRIDGE_VERSION = '1';

export type CallTarget = 'customer' | 'rider' | 'driver' | 'store' | 'recipient';

export interface CallConfig {
  enabled: boolean;
  /** Swift's own number calls come from (only while the bridge is on). */
  callerId: string | null;
}

export type CallChoice = { mode: 'bridge' } | { mode: 'dial'; phone: string } | { mode: 'none' };

/** What the Call control does for this order and person. */
export function callChoice(config: CallConfig | null | undefined, phone: string | null | undefined, orderId?: string | null): CallChoice {
  if (config?.enabled && orderId) return { mode: 'bridge' };
  if (phone) return { mode: 'dial', phone };
  return { mode: 'none' };
}

/** The words people read (REVIEW-F). */
export const CALL_WORDS = {
  viaSwift: 'Call via Swift',
  started: 'Swift is calling you now',
  // [REVIEW-F #2092 S4-1] True for every app: while older apps still get counterpart numbers, "neither of
  // you sees the other's number" can be false; on this call both phones show Swift's number.
  startedHow: 'Answer, then press 1. Swift will then ring them. Both phones show Swift\'s number.',
  failedTitle: 'Call not started',
} as const;

/** "Save Swift's number" — so a call from Swift is recognised (Guyana phones show only a number). */
export function saveNumberTip(callerId: string | null | undefined): string | null {
  return callerId ? `Swift calls come from ${callerId}. Save it in your contacts as “Swift” so you know it’s us.` : null;
}

/** The server's refusal, in the person's words. Unknown codes get a safe general line. */
export function bridgeErrorText(code: string | null | undefined): string {
  switch (code) {
    case 'CALL_RELAY_OFF': return 'Calls through Swift are not on yet. Message them in chat, or ask support to connect you.';
    case 'CALL_ORDER_NOT_LIVE': return 'This order is finished, so Swift can no longer connect a call. Message them in chat or ask support.';
    case 'CALL_IN_PROGRESS': return 'A Swift call on this order is already ringing. Answer it, or try again in a minute.';
    case 'CALL_LIMIT_REACHED': return 'Swift has connected as many calls as it can for this order. Message them in chat, or ask support.';
    case 'CALL_NO_NUMBER': return 'Swift has no number to call for this. Message them in chat, or ask support.';
    default: return 'Swift could not place the call right now. Try again, or message them in chat.';
  }
}
