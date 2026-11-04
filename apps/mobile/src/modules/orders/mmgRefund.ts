// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G08] The MMG refund on an order, as the server projects it (order/mmg-refund-rail.ts). The screens render these
// words and decide nothing: the same reading for the customer's card, the store's card and their tests. Anything unreadable
// is no card at all, never a card that claims something.
// ---------------------------------------------------------------------------

export interface MmgRefundView {
  state: 'OWED' | 'OVERDUE' | 'SENT' | 'DISPUTED' | 'DONE';
  amount: string;
  line: string;
  /** Customer: the send to answer. */
  sendId: string | null;
  canAnswer: boolean;
  /** Store: the door. */
  canMarkSent: boolean;
}

const STATES: ReadonlySet<string> = new Set(['OWED', 'OVERDUE', 'SENT', 'DISPUTED', 'DONE']);

export function parseMmgRefundView(raw: unknown): MmgRefundView | null {
  const view = raw as Partial<Record<keyof MmgRefundView, unknown>> | null | undefined;
  if (!view || typeof view.state !== 'string' || !STATES.has(view.state) || typeof view.line !== 'string' || view.line.trim() === '' || typeof view.amount !== 'string') return null;
  const sendId = typeof view.sendId === 'string' && view.sendId !== '' ? view.sendId : null;
  return {
    state: view.state as MmgRefundView['state'], amount: view.amount, line: view.line, sendId,
    canAnswer: view.canAnswer === true && sendId !== null,
    canMarkSent: view.canMarkSent === true,
  };
}

export const MMG_REFUND_WORDS = {
  title: 'MMG refund',
  arrived: 'It arrived',
  notArrived: 'It did not arrive',
  confirmNotArrived: 'Swift support will check with the store.',
  markSent: 'Refund sent',
  sheetTitle: 'Refund sent',
  sheetBody: 'Send the refund from your MMG first. Then enter the reference from your MMG message.',
  referenceLabel: 'MMG reference',
  confirm: 'I sent it',
  keep: 'Not yet',
  /** Only when the server gave no words (no connection, a timeout). */
  fallback: 'Couldn’t record that. Check your connection and try again.',
} as const;

export const mmgRefundTone = (view: MmgRefundView): 'warning' | 'success' | 'neutral' => (view.state === 'DONE' ? 'success' : view.state === 'OVERDUE' || view.state === 'DISPUTED' ? 'warning' : 'neutral');
