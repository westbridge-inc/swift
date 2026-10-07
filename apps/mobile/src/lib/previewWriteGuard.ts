import type { AxiosInstance } from 'axios';

/**
 * THE PREVIEW CANNOT WRITE — the transport backstop.
 *
 * A rider or taxi driver can open "Preview your dashboard" from their
 * documents while signed in. The preview's own controls are no-ops (the hooks
 * return lib/moverPreviewData's previewMutation), but their session is real: a
 * write that slipped past a screen would change their real account — go online,
 * take a job, move a pay link, swap a vehicle. So while the preview is on
 * screen, the app's client lets reads through and stops every write on the
 * phone, before any network.
 *
 * Mechanics: a SYNCHRONOUS request interceptor cannot stop a request by
 * throwing — axios 1.x's synchronous chain hands the throw to the interceptor's
 * error handler and then dispatches anyway (or, with no handler, fails with an
 * unrelated TypeError). So the guard swaps the request's adapter for one that
 * rejects locally. No server response is invented: the refusal carries no
 * `response`, so status-driven code (refresh on 401, "already gone" on 404/409)
 * can never mistake it for the server's answer.
 */

export const PREVIEW_READ_ONLY = 'PREVIEW_READ_ONLY' as const;
export const PREVIEW_READ_ONLY_MESSAGE = 'This is a preview — nothing was changed.';

/** The methods that read. Everything else writes. */
const READ_METHODS: ReadonlySet<string> = new Set(['get', 'head', 'options']);

export function isWriteMethod(method: string | undefined): boolean {
  return !READ_METHODS.has(String(method ?? 'get').toLowerCase());
}

export class PreviewReadOnlyError extends Error {
  readonly code = PREVIEW_READ_ONLY;

  constructor(readonly method: string, readonly url: string | undefined) {
    super(PREVIEW_READ_ONLY_MESSAGE);
    this.name = 'PreviewReadOnlyError';
  }
}

/** Install on a client. `previewShowing` is read per request, so the guard
 *  follows the preview on and off with no re-install. */
export function installPreviewWriteGuard(client: AxiosInstance, previewShowing: () => boolean): void {
  client.interceptors.request.use((config) => {
    // The method is checked first: a read never consults the preview state.
    if (isWriteMethod(config.method) && previewShowing()) {
      const refusal = new PreviewReadOnlyError(String(config.method).toUpperCase(), config.url);
      config.adapter = () => Promise.reject(refusal);
    }
    return config;
  }, undefined, { synchronous: true });
}
