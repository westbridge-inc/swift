import { errorMessage } from '../../lib/apiError';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G20] "NOT COLLECTED" in the partner app. The server (PUT /vendor/orders/:id/not-collected) closes a cash pickup
// nobody came for, from 24 hours after it was ready, and sends a paid MMG one to Swift support. The server's own word on the
// order (notCollected { allowed, goesToSupport }) decides the button; a refusal is shown in the server's words.
// ---------------------------------------------------------------------------

export const NOT_COLLECTED_WORDS = {
  button: 'Not collected',
  confirmTitle: 'Mark as not collected?',
  confirmBody: 'The order closes. No money moves. The customer is told.',
  confirmBodySupport: 'It was paid by MMG, so Swift support closes it with you. The order stays open until they do.',
  confirmYes: 'Yes, nobody came',
  keep: 'Keep the order',
  closedTitle: 'Order closed',
  closedLine: 'Recorded: not collected. No money moved.',
  supportTitle: 'With Swift support',
  supportLine: 'Swift support has this order. They close it and record the refund you owe the customer.',
  done: 'Done',
  /** Only when the server gave no words (no connection, a timeout). */
  fallback: 'Couldn’t record that. Check your connection and try again.',
} as const;

type Word = { notCollected?: { allowed?: unknown; goesToSupport?: unknown } | null; fulfillment?: unknown; status?: unknown };

/** The server says the store may mark this ready pickup now. An older server sends no word: no button. */
export function notCollectedOpen(order: Word | null | undefined): boolean {
  return order?.notCollected?.allowed === true && order.fulfillment === 'PICKUP' && String(order.status ?? '').toUpperCase() === 'READY_FOR_PICKUP';
}

/** It stays open and goes to Swift support: the server's word, or its answer. */
export function notCollectedGoesToSupport(order: Word | null | undefined): boolean {
  return order?.notCollected?.goesToSupport === true;
}

export function notCollectedSentToSupport(answer: unknown): boolean {
  return (answer as { sentToSupport?: unknown } | null | undefined)?.sentToSupport === true;
}

export const notCollectedRefusalWords = (error: unknown): string => errorMessage(error, NOT_COLLECTED_WORDS.fallback);
