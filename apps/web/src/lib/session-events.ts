// Cross-tab messages carry only an invalidation nonce, never a user or token.
const KEY = 'swift_web_session_changed';
let channel: BroadcastChannel | undefined;
let started = false;
const source = Math.random().toString(36).slice(2);
let sequence = 0;

export function listenForSessionInvalidation(invalidate: () => void): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const seen = new Set<string>();
  const receive = (value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith('invalidate:') || value.startsWith(`invalidate:${source}:`) || seen.has(value)) return;
    seen.add(value);
    if (seen.size > 64) seen.delete(seen.values().next().value!);
    invalidate();
  };
  try {
    channel = new BroadcastChannel(KEY);
    channel.onmessage = (event) => receive(event.data);
  } catch { /* Older/restricted browsers use the storage event below. */ }
  try {
    window.addEventListener('storage', (event) => {
      if (event.key === KEY) receive(event.newValue);
    });
  } catch { /* Cache reuse still requires a server identity check. */ }
}

export function publishSessionInvalidation(): void {
  const nonce = `invalidate:${source}:${++sequence}`;
  try {
    channel?.postMessage(nonce);
  } catch { /* A closed/blocked channel falls back to storage. */ }
  // Also reach a peer whose channel failed even when ours succeeded. The
  // receiver deduplicates the two deliveries and never trusts their contents.
  try {
    window.localStorage.setItem(KEY, nonce);
    window.localStorage.removeItem(KEY);
  } catch { /* No transport is a reason to revalidate, never to trust a cache. */ }
}

export function clearPrivateBrowserState(): void {
  try { window.localStorage.removeItem('swift_web_appointments'); } catch { /* Storage disabled. */ }
}
