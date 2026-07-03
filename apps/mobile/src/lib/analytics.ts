import { zustandStorage } from './storage';
import { useAuthStore } from '../stores/authStore';

// ---------------------------------------------------------------------------
// Product analytics (build kit: PostHog). Owned, dependency-light client over
// PostHog's capture API — config-gated and PRIVACY-SAFE by construction:
//   · disabled entirely unless EXPO_PUBLIC_POSTHOG_KEY is set
//   · distinct id = the opaque user id (or a random anonymous id) — never
//     phone numbers, names, or any document data
//   · fire-and-forget with a swallow-all catch: analytics can never break,
//     slow, or block a user flow
// ---------------------------------------------------------------------------

const KEY = process.env['EXPO_PUBLIC_POSTHOG_KEY'];
const HOST = (process.env['EXPO_PUBLIC_POSTHOG_HOST'] ?? 'https://us.i.posthog.com').replace(/\/$/, '');
const ANON_ID_KEY = 'analytics-anon-id';

function anonId(): string {
  try {
    const existing = zustandStorage.getItem(ANON_ID_KEY);
    if (typeof existing === 'string' && existing) return existing;
    // Non-crypto randomness is fine for an anonymous analytics id.
    const fresh = `anon_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    zustandStorage.setItem(ANON_ID_KEY, fresh);
    return fresh;
  } catch {
    return 'anon_unknown'; // storage not ready yet — still never throw
  }
}

/** Track a product event. No-op without a key; never throws; never blocks. */
export function track(event: string, properties: Record<string, string | number | boolean> = {}): void {
  if (!KEY) return;
  try {
    const userId = useAuthStore.getState().user?.id;
    void fetch(`${HOST}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: KEY,
        event,
        distinct_id: userId ?? anonId(),
        properties: { ...properties, platform: 'mobile' },
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => undefined);
  } catch {
    // storage/store not ready — drop the event, never the flow
  }
}
