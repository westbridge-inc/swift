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

/** Swift's number spaced to read: +1 878 555 0123 (North America), +592 600 1234 (Guyana); any other as sent. */
export function formatCallerId(callerId: string): string {
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(callerId);
  if (nanp) return `+1 ${nanp[1]} ${nanp[2]} ${nanp[3]}`;
  const gy = /^\+592(\d{3})(\d{4})$/.exec(callerId);
  if (gy) return `+592 ${gy[1]} ${gy[2]}`;
  return callerId;
}

/**
 * [CALL-RELAY-ON · owner 6 Nov 2026] "So a call does not look like a scam": Guyana networks show only the
 * number for an incoming call, never a name. The number is the server's (GET /calls/config), never typed
 * here. Plain GSM-7 words, so the same line also fits a text message.
 */
export function callerLine(callerId: string | null | undefined): string | null {
  return callerId ? `Swift calls you from ${formatCallerId(callerId)} (save it as Swift).` : null;
}

export const CALLER_LINE_WORDS = {
  copy: 'Copy number',
  copyA11y: "Copy Swift's call number",
  copied: 'Number copied',
  copiedHow: 'Save it in your contacts as Swift.',
  copyFailed: 'Press and hold the number to copy it.',
} as const;

/**
 * [O-1 · COORD 26 Oct] The courier rider's call to the PARCEL RECIPIENT. They did not place the order, so
 * their card says who they are in role words, and Swift rings them "about a delivery for you" (what they
 * hear). This app has never shown the number the sender typed for them, so it is never dialled from here:
 * the control exists only while calls go through Swift.
 */
export const RECIPIENT_CALL_WORDS = {
  title: 'Parcel recipient',
  subtitle: 'Swift rings them about their delivery',
  a11y: 'Call the parcel recipient via Swift',
} as const;

/** The recipient has no Swift account and no chat: a refusal offers the sender's chat or support instead. */
function recipientRefusal(code: string | null | undefined): string {
  switch (code) {
    case 'CALL_RELAY_OFF': return 'Calls through Swift are not on yet. Message the sender in chat, or ask support to reach the recipient.';
    case 'CALL_ORDER_NOT_LIVE': return 'This delivery is finished, so Swift can no longer connect a call. Ask support if you need to reach the recipient.';
    case 'CALL_IN_PROGRESS': return 'A Swift call on this order is already ringing. Answer it, or try again in a minute.';
    case 'CALL_LIMIT_REACHED': return 'Swift has connected as many calls as it can for this order. Message the sender in chat, or ask support.';
    case 'CALL_NO_NUMBER': return 'Swift has no number for the recipient. Message the sender in chat, or ask support.';
    case 'CALL_DAILY_LIMIT_REACHED': return 'Swift calls are busy right now. Message the sender in chat, or ask support.';
    default: return 'Swift could not place the call right now. Try again, or message the sender in chat.';
  }
}

/** [CALL-RELAY-ON] The server's daily cap on Swift calls (CALL_RELAY_MAX_CALLS_PER_DAY) was reached. */
const DAILY_LIMIT_WORDS = 'Swift calls are busy right now. Message them in chat, or ask support.';

/** The server's refusal, in the person's words. Unknown codes get a safe general line. */
export function bridgeErrorText(code: string | null | undefined, target?: CallTarget): string {
  if (target === 'recipient') return recipientRefusal(code);
  switch (code) {
    case 'CALL_RELAY_OFF': return 'Calls through Swift are not on yet. Message them in chat, or ask support to connect you.';
    case 'CALL_ORDER_NOT_LIVE': return 'This order is finished, so Swift can no longer connect a call. Message them in chat or ask support.';
    case 'CALL_IN_PROGRESS': return 'A Swift call on this order is already ringing. Answer it, or try again in a minute.';
    case 'CALL_LIMIT_REACHED': return 'Swift has connected as many calls as it can for this order. Message them in chat, or ask support.';
    case 'CALL_NO_NUMBER': return 'Swift has no number to call for this. Message them in chat, or ask support.';
    case 'CALL_DAILY_LIMIT_REACHED': return DAILY_LIMIT_WORDS;
    default: return 'Swift could not place the call right now. Try again, or message them in chat.';
  }
}
