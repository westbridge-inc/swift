/**
 * [INAPP-CALLS · owner 6 Nov 2026, "B"] Calling inside the Swift app.
 *
 * "Call in app" sits beside "Call via Swift". It goes over the internet: the
 * other person's phone shows a full call screen, "Swift: your rider is calling
 * about your order" (role words, never a number). If they do not answer in the
 * app, Swift rings their phone through the call bridge in the same call.
 *
 * The button shows only when ALL of these hold:
 * - the server's INAPP_CALLS switch is on (GET /calls/app/config);
 * - this phone's app has the calling module (build 13 and later; the module is
 *   loaded with a guarded require, so builds 11/12 simply never show it);
 * - there is an order, and the person is not the parcel recipient (no app).
 *
 * Pure: no React, no network, no native module.
 */
import type { CallTarget } from './callBridge';

export interface InAppConfig {
  enabled: boolean;
}

/** Offer "Call in app" for this person on this order? */
export function offerInApp(config: InAppConfig | null | undefined, available: boolean, orderId: string | null | undefined, target: CallTarget): boolean {
  return !!config?.enabled && available && !!orderId && target !== 'recipient';
}

/** The words people read. Plain, short, no number. */
export const INAPP_WORDS = {
  label: 'Call in app',
  hint: 'Calls them inside the Swift app, over the internet. Your number stays hidden.',
  a11y: 'Call in the Swift app',
  calling: 'Calling in the app',
  callingHow: 'Their phone shows a Swift call screen. If they do not answer in the app, Swift rings their phone.',
  endLabel: 'End call',
  failedTitle: 'Call not started',
  micTitle: 'Microphone needed',
  /** Shown before the system asks (Android), and after a refusal (both). */
  micWhy: 'Swift needs the microphone so you can talk on in-app calls. Swift never records calls.',
  micRefused: 'The microphone is off for Swift, so in-app calls cannot work. You can turn it on in Settings, or use Call via Swift.',
} as const;

/** The server's refusal, in the person's words. Unknown codes get a safe general line. */
export function inAppErrorText(code: string | null | undefined): string {
  switch (code) {
    case 'INAPP_CALLS_OFF': return 'In-app calls are not on yet. Use Call via Swift, or message them in chat.';
    case 'CALL_ORDER_NOT_LIVE': return 'This order is finished, so Swift can no longer connect a call. Message them in chat or ask support.';
    case 'CALL_IN_PROGRESS': return 'A Swift call on this order is already ringing. Answer it, or try again in a minute.';
    case 'CALL_LIMIT_REACHED': return 'Swift has connected as many calls as it can for this order. Message them in chat, or ask support.';
    case 'INAPP_NO_ONE': return 'There is no one to call in the app for this. Message them in chat, or ask support.';
    case 'INAPP_NOT_FOR_TARGET': return 'They do not have the Swift app. Use Call via Swift instead.';
    case 'MIC_REFUSED': return INAPP_WORDS.micRefused;
    default: return 'Swift could not start the in-app call. Try again, use Call via Swift, or message them in chat.';
  }
}

/** The call-screen template the native module fills from the server's `swiftLine` parameter. */
export const CALL_SCREEN_TEMPLATE = '$' + '{swiftLine}';
/** What CallKit shows in the phone's recent calls for a call this person placed (never a number). */
export const OUTGOING_HANDLE = 'Swift';
