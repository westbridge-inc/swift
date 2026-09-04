/**
 * [MKT G7 / B5] The launch-depth gate — the tab hides while the catalogue is thin.
 *
 * SWIFT_MARKETPLACE §5.4 states the product law plainly: **"An empty
 * marketplace is worse than no marketplace."** G7 is the mechanism —
 * *"hide the tab below ~150 items / 2 vendors"* — and its own note describes
 * the failure it exists to prevent: *"The tab ships with one store in it."*
 *
 * That is exactly what shipped. `CustomerStack.tsx` mounts `<Tab.Screen
 * name="Market">` unconditionally, while `market.routes.ts` carries a comment
 * asserting *"the tab itself stays hidden below ~150 items"*. The comment was
 * true of the design and false of the code: nothing hid anything. A founder
 * opening the app found a Market tab containing four hardware items from one
 * store, and reported — correctly — that it "is not a marketplace".
 *
 * The decision lives HERE, on the server, and the client obeys the `visible`
 * flag rather than re-deriving it. A threshold duplicated across a client and
 * a server is a threshold that will disagree with itself; and only the server
 * can see the whole catalogue anyway.
 *
 * Numbers are MKT-1's, held as config because M-F3 lists ratifying them as a
 * founder decision. They are defaults, not doctrine — but "no gate at all" is
 * not one of the options the spec offers.
 */

/** MKT-1's numbers, pending M-F3 ratification. */
export const MARKET_MIN_ITEMS = 150;
export const MARKET_MIN_VENDORS = 2;

export interface MarketDepth {
  /** Live, visible retail items — the things a shopper could actually buy. */
  items: number;
  /** Distinct retail sellers behind them. One store is a shop, not a market. */
  vendors: number;
}

export interface MarketDepthThresholds {
  minItems: number;
  minVendors: number;
}

export interface MarketGate extends MarketDepth, MarketDepthThresholds {
  visible: boolean;
  /** Why it is hidden, for the ops surface — never shown to a shopper. */
  reason: 'ok' | 'too_few_items' | 'too_few_vendors' | 'too_few_items_and_vendors';
}

/**
 * BOTH conditions must hold. 150 items from a single seller is a catalogue,
 * not a marketplace — the shopper sees one shop wearing a market's name, which
 * is the exact first impression §5.4 forbids. Two sellers with four items
 * between them is just as thin. The gate is an AND, deliberately.
 */
export function marketGate(
  depth: MarketDepth,
  thresholds: MarketDepthThresholds = { minItems: MARKET_MIN_ITEMS, minVendors: MARKET_MIN_VENDORS },
): MarketGate {
  const enoughItems = depth.items >= thresholds.minItems;
  const enoughVendors = depth.vendors >= thresholds.minVendors;
  const reason: MarketGate['reason'] = enoughItems && enoughVendors
    ? 'ok'
    : !enoughItems && !enoughVendors
      ? 'too_few_items_and_vendors'
      : enoughItems
        ? 'too_few_vendors'
        : 'too_few_items';
  return {
    ...depth,
    ...thresholds,
    visible: enoughItems && enoughVendors,
    reason,
  };
}

/**
 * Read the thresholds an operator has set, falling back to MKT-1's numbers.
 *
 * A malformed or absent value is NOT an open gate: a typo in config must not
 * be the thing that puts a one-store marketplace in front of a customer, so
 * anything unparseable falls back to the spec default rather than to zero.
 */
export function thresholdsFrom(
  config: Record<string, unknown> | null | undefined,
): MarketDepthThresholds {
  const read = (key: string, fallback: number): number => {
    const raw = config?.[key];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    minItems: read('MARKET_MIN_ITEMS', MARKET_MIN_ITEMS),
    minVendors: read('MARKET_MIN_VENDORS', MARKET_MIN_VENDORS),
  };
}
