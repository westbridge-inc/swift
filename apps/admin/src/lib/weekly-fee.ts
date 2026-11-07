// [CHAINS · REVIEW-M #2211] The weekly fee a store or mover is CHARGED, as the
// biller reads it (api billing/subscription-fee.ts weeklyFeeFor): a custom rate
// (a chain deal, a frozen rate) wins over the tier's list rate but is never
// above it, so the lower of the two. Staff must see the charged fee, never a
// deal the store is not paying because its own tier fee is lower.

type Amount = number | string | null | undefined;

const amountOf = (raw: Amount): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function chargedWeeklyFee(sub: { weeklyRate?: Amount; customRate?: Amount }): number | null {
  const list = amountOf(sub.weeklyRate);
  const custom = amountOf(sub.customRate);
  if (custom === null) return list;
  if (list === null) return custom;
  return Math.min(custom, list);
}
