import type { TopupRail } from './ledger';

// ---------------------------------------------------------------------------
// [OWNER 5 Nov 2026] The three ways a weekly fee is paid directly to Westbridge
// Inc. in person, and how each one reads on a receipt and in the books. Plain
// data, so a receipt can read it without loading the payment door.
// ---------------------------------------------------------------------------

export const IN_PERSON_METHODS = ['CASH', 'CHEQUE', 'BANK_TRANSFER'] as const;
export type InPersonMethod = (typeof IN_PERSON_METHODS)[number];

const WAYS: Record<InPersonMethod, { channel: string; rail: TopupRail; words: string }> = {
  CASH: { channel: 'IN_PERSON_CASH', rail: 'IN_PERSON_CASH', words: 'cash' },
  CHEQUE: { channel: 'IN_PERSON_CHEQUE', rail: 'IN_PERSON_BANK', words: 'cheque (cleared)' },
  BANK_TRANSFER: { channel: 'IN_PERSON_BANK_TRANSFER', rail: 'IN_PERSON_BANK', words: 'bank transfer' },
};

export const inPersonChannel = (method: InPersonMethod): string => WAYS[method].channel;
export const inPersonRail = (method: InPersonMethod): TopupRail => WAYS[method].rail;
/** Every receipt channel of a fee paid in person: what finance lists apart from MMG. */
export const IN_PERSON_CHANNELS: readonly string[] = IN_PERSON_METHODS.map(inPersonChannel);
export const inPersonMethodOf = (channel: string | null): InPersonMethod | null =>
  IN_PERSON_METHODS.find((method) => WAYS[method].channel === channel) ?? null;

/** The receipt's line for a fee paid in person; nothing for any other receipt. */
export function inPersonReceiptLine(channel: string | null, reference: string | null): string[] {
  const method = inPersonMethodOf(channel);
  if (!method) return [];
  return [`Paid in person to Westbridge Inc. by ${WAYS[method].words}${reference ? `. Reference: ${reference}` : ''}`];
}
