// [RETIER PR-A2 · owner 30 Oct 2026] A new store's weekly fee follows its own catalogue when Swift approves it. Above
// the first step, the store goes live only after its owner reads that exact fee and ticks "I understand the weekly
// fee" for it. Everything here is the server's (GET /vendor/onboarding/weekly-fee): the amount, the currency, why, the
// words and their version. The app never supplies a figure or the words itself, so an older server — or a malformed
// answer — shows no card. No React Native imports: the card and its tests share it.

export interface StoreFeeItem { heading: string; text: string }

export interface StoreFeeToTick {
  amount: number;
  currencyCode: string;
  version: string;
  why: string | null;
  items: StoreFeeItem[];
  tick: string;
}

/** The fee this store's owner still has to read and tick, or null (nothing to tick, already ticked, or no words). */
export function storeFeeToTick(view: unknown): StoreFeeToTick | null {
  const v = view as Record<string, unknown> | null | undefined;
  if (!v || typeof v !== 'object' || v['required'] !== true || v['ticked'] !== false) return null;
  const fee = v['weeklyFee'] as Record<string, unknown> | null | undefined;
  const terms = v['terms'] as Record<string, unknown> | null | undefined;
  if (!fee || typeof fee['amount'] !== 'number' || !(fee['amount'] > 0) || typeof fee['currencyCode'] !== 'string' || typeof fee['version'] !== 'string') return null;
  if (!terms || typeof terms['tick'] !== 'string' || !terms['tick'] || terms['version'] !== fee['version'] || !Array.isArray(terms['items'])) return null;
  const items = (terms['items'] as unknown[]).filter((i): i is StoreFeeItem => {
    const r = i as Partial<StoreFeeItem> | null;
    return !!r && typeof r.heading === 'string' && typeof r.text === 'string';
  });
  if (items.length === 0) return null;
  return {
    amount: fee['amount'], currencyCode: fee['currencyCode'], version: fee['version'],
    why: typeof v['why'] === 'string' && v['why'] ? v['why'] : null, items, tick: terms['tick'],
  };
}

/** The tick as the server takes it: the words' version and the exact fee the owner saw. */
export function storeFeeAck(fee: StoreFeeToTick): { version: string; amount: number; currencyCode: string } {
  return { version: fee.version, amount: fee.amount, currencyCode: fee.currencyCode };
}

/** Roles whose checklist is a store's (a Services business included). */
export const STORE_ROLES: ReadonlySet<string> = new Set(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']);
