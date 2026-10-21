import { lazy, useCallback, useEffect, useState, type ComponentType } from 'react';

// [PERF #7] A page's code arrives in pieces ("chunks"). One can fail to arrive:
// a dropped request on a phone network, or a deploy that replaced the files
// while the page was open. React keeps a failed lazy import for good, so one
// lost request used to break the page (the "Something went wrong" screen)
// and its "Try again" re-threw the same failure until a full reload.
//
// Now: every on-demand import tries once more after a short pause; whatever
// still fails to load (a page's own chunk during navigation, or both tries)
// reaches the error screen, which reloads the page once by itself. A second
// failure within a minute shows the screen, and "Try again" reloads the page.
// Only a load failure is retried: a real error in the code is not hidden.

export const CHUNK_RETRY_DELAY_MS = 800;
const RELOAD_KEY = 'swift.chunk-reload';
const RELOAD_WINDOW_MS = 60_000;

/** A failure to fetch code, not an error in it (webpack JS or CSS chunk, or a browser's own module loader). */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message, code } = error as { name?: unknown; message?: unknown; code?: unknown };
  if (name === 'ChunkLoadError' || code === 'CSS_CHUNK_LOAD_FAILED') return true;
  return typeof message === 'string'
    && /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}

/** The same import, tried once more after a short pause when its code failed to arrive. */
export function retryImport<T>(load: () => Promise<T>, delayMs = CHUNK_RETRY_DELAY_MS): () => Promise<T> {
  return () => load().catch((error: unknown) => {
    if (!isChunkLoadError(error)) throw error;
    return new Promise<T>((resolve, reject) => { setTimeout(() => { load().then(resolve, reject); }, delayMs); });
  });
}

/** React.lazy whose import is tried twice before the page gives up. */
export function lazyRetry<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(retryImport(load));
}

function lastReload(): number | null {
  try {
    const at = Number(window.sessionStorage.getItem(RELOAD_KEY));
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return null; // storage unavailable: never reload by itself (it could not tell a loop)
  }
}

/** True when the error screen may reload the page by itself: a load failure, and no such reload in the last minute. */
export function mayReloadForChunk(error: unknown, now = Date.now()): boolean {
  if (!isChunkLoadError(error)) return false;
  const at = lastReload();
  return at !== null && now - at > RELOAD_WINDOW_MS;
}

/** Reload the page once, remembering when (so a page that keeps failing stops reloading). */
export function reloadForChunk(now = Date.now()): void {
  try { window.sessionStorage.setItem(RELOAD_KEY, String(now)); } catch { /* checked by mayReloadForChunk */ }
  window.location.reload();
}

/** For an error screen: reloads once by itself for a load failure (`reloading`), and makes
 *  "Try again" reload the page for one (re-rendering would re-throw the kept failure). */
export function useChunkRecovery(error: unknown, reset: () => void): { reloading: boolean; retry: () => void } {
  const chunk = isChunkLoadError(error);
  const [reloading] = useState(() => mayReloadForChunk(error));
  useEffect(() => { if (reloading) reloadForChunk(); }, [reloading]);
  const retry = useCallback(() => { if (chunk) reloadForChunk(); else reset(); }, [chunk, reset]);
  return { reloading, retry };
}
