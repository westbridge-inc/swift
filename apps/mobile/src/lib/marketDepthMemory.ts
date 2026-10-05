import { MMKV } from 'react-native-mmkv';
import { marketDepthVerdict } from './homeReliability';

/** A complete server depth verdict — the only shape worth remembering. */
export interface MarketDepthBody {
  visible: boolean;
  items: number;
  vendors: number;
}

const STORE_ID = 'swift-market';
const DEPTH_SLOT = 'depth';

// Catalogue depth is public data (no account, no PII), so it rides the same
// guarded plain-MMKV pattern as the ads cache — the encrypted store is for
// auth. A stale memory is harmless: it only seeds the depth query until the
// next COMPLETE server verdict arrives, and an unknown body never writes.
// One slot, not per account: the server computes depth for the single public
// market tenant (resolvePublicMarketTenant), the same for every viewer, and
// logout's queryClient.clear() does not need to touch it. If depth ever
// becomes per-country or per-tenant, key this slot by that scope (DS206 D5).
let store: MMKV | null = null;
try {
  store = new MMKV({ id: STORE_ID });
} catch {
  store = null;
}

function depthOf(raw: unknown): MarketDepthBody | null {
  if (marketDepthVerdict(raw) === 'unknown') return null;
  const value = raw as Record<string, unknown>;
  return {
    visible: value['visible'] as boolean,
    items: value['items'] as number,
    vendors: value['vendors'] as number,
  };
}

/** The last complete verdict this device saw, or null when none was ever
 *  stored (or the stored value no longer parses as one). */
export function rememberedMarketDepth(): MarketDepthBody | null {
  try {
    const raw = store?.getString(DEPTH_SLOT);
    return raw ? depthOf(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Persist ONLY a complete verdict. A failed or unknown read leaves memory as
 *  it was, so a flapping endpoint cannot erase a known-visible tab. */
export function rememberMarketDepth(body: unknown): void {
  const depth = depthOf(body);
  if (!depth) return;
  try {
    store?.set(DEPTH_SLOT, JSON.stringify(depth));
  } catch {
    // Best-effort: losing this write only costs the next cold start's seed.
  }
}
