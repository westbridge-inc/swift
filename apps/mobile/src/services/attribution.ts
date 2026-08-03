import { Platform } from 'react-native';
import { MMKV } from 'react-native-mmkv';
import * as Crypto from 'expo-crypto';
import { api } from './api';
import { safeNavigate } from '../navigation/navigationRef';

// First-launch install attribution [qr spec Part 6.4]. On the TRUE first
// launch the app claims its install: iOS matches the server-side fingerprint
// filed when the user tapped "Get the app" on a scanned storefront — exactly
// one candidate or Home, the server never guesses. destination non-null →
// the storefront navigation queues behind onboarding/auth (we never fight
// the auth flow) and fires when the container is ready.
//
// Android's deterministic Play Install Referrer needs a native module — it
// rides the next native rebuild; until then Android claims without a referrer
// and lands Home (graceful, documented).

const store = new MMKV({ id: 'swift-attribution' });
const KEY_CLAIMED = 'attribution.claimed';
const KEY_INSTALL_ID = 'attribution.installId';

let pendingDestination: string | null = null;

function installId(): string {
  const existing = store.getString(KEY_INSTALL_ID);
  if (existing) return existing;
  const id = `inst-${Crypto.randomUUID()}`;
  store.set(KEY_INSTALL_ID, id);
  return id;
}

async function goToStorePath(path: string): Promise<boolean> {
  // destination is always "/store/{slug}" (the ONLY thing claims return).
  const slug = /^\/store\/([a-z0-9-]{1,80})$/.exec(path)?.[1];
  if (!slug) return true; // unknown shape — treat as delivered (Home)
  try {
    const res = await api.get(`/public/storefronts/${slug}`);
    const vendorId = (res.data?.data as { id?: string } | undefined)?.id;
    if (!vendorId) return true; // store gone — Home is correct
    return safeNavigate('Restaurant', { vendorId });
  } catch {
    return true; // network blip — never block or retry-loop the first open
  }
}

/** RootNavigator onReady: deliver a queued attributed destination. */
export function flushAttributedDestination(): void {
  if (!pendingDestination) return;
  const path = pendingDestination;
  pendingDestination = null;
  setTimeout(() => {
    void goToStorePath(path).then((delivered) => {
      if (!delivered) pendingDestination = path;
    });
  }, 400);
}

/** Call once at app start. Claims exactly once per install (the server's
 *  receipt makes even a double-fire idempotent); only a SUCCESSFUL claim
 *  marks done, so a network blip retries next boot — safe by design. */
export function ensureFirstLaunchClaim(): void {
  if (store.getBoolean(KEY_CLAIMED)) return;
  void api
    .post('/attribution/claim', { installId: installId(), platform: Platform.OS === 'android' ? 'android' : 'ios' })
    .then((res) => {
      store.set(KEY_CLAIMED, true);
      const destination = (res.data?.data as { destination?: string | null } | undefined)?.destination ?? null;
      if (destination) pendingDestination = destination;
    })
    .catch(() => undefined);
}

/** Test seam. */
export function resetAttributionForTests(): void {
  pendingDestination = null;
}
