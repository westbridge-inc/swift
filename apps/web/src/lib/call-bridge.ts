import { apiFetch, ApiRequestError } from '@/lib/auth';

/**
 * [O-1 · owner 22-24 Oct 2026] Calling the other person on an order, on the website.
 *
 * - Bridge OFF (the launch state): exactly today's behaviour: the API still sends the number, and
 *   "Call" is a tel: link.
 * - Bridge ON: the API sends no personal number. "Call via Swift" asks Swift to connect the call:
 *   Swift rings the signed-in person's own phone first; they answer and press 1, then Swift rings
 *   the other person. Neither sees the other's number.
 * - Neither: no Call button (chat and support remain).
 */

export type CallTarget = 'customer' | 'rider' | 'driver' | 'store' | 'recipient';
export interface CallConfig { enabled: boolean; callerId: string | null }
export type CallChoice = { mode: 'bridge' } | { mode: 'dial'; href: string } | { mode: 'none' };

/** A `tel:` target only for something that is a phone number. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/[^\d+]/g, '');
  return /^\+?\d{5,}$/.test(digits) ? `tel:${digits}` : null;
}

export function callChoice(config: CallConfig | null | undefined, phone: string | null | undefined, orderId?: string | null): CallChoice {
  if (config?.enabled && orderId) return { mode: 'bridge' };
  const href = telHref(phone);
  return href ? { mode: 'dial', href } : { mode: 'none' };
}

export const CALL_WORDS = {
  viaSwift: 'Call via Swift',
  calling: 'Calling…',
  started: 'Swift is calling your phone now. Answer, then press 1. Swift will then ring them. Neither of you sees the other’s number.',
} as const;

export function saveNumberTip(callerId: string | null | undefined): string | null {
  return callerId ? `Swift calls come from ${callerId}. Save it in your contacts as “Swift” so you know it’s us.` : null;
}

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

const CONFIG_TTL_MS = 5 * 60_000;
let cached: { at: number; value: Promise<CallConfig | null> } | null = null;

/** The switch as the API reports it, cached for a few minutes. A failed read is "off": the page behaves exactly as today. */
export function fetchCallConfig(now = Date.now()): Promise<CallConfig | null> {
  if (!cached || now - cached.at >= CONFIG_TTL_MS) cached = { at: now, value: readCallConfig() };
  return cached.value;
}

/** Tests only. */
export function resetCallConfigForTests(): void { cached = null; }

async function readCallConfig(): Promise<CallConfig | null> {
  try {
    const body = await apiFetch('/api/v1/calls/config', undefined, { redirectOnExpired: false });
    const d = body?.data;
    return d && typeof d.enabled === 'boolean' ? { enabled: d.enabled, callerId: d.callerId ?? null } : null;
  } catch {
    return null;
  }
}

/** Ask Swift to connect the call. Resolves to the words to show the person. */
export async function startSwiftCall(orderId: string, target: CallTarget): Promise<{ ok: boolean; message: string }> {
  try {
    await apiFetch('/api/v1/calls/bridge', { method: 'POST', body: JSON.stringify({ orderId, target }) });
    return { ok: true, message: CALL_WORDS.started };
  } catch (e) {
    return { ok: false, message: bridgeErrorText(e instanceof ApiRequestError ? e.code : undefined) };
  }
}
