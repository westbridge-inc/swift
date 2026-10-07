import { useAuthStore } from './authStore';
import { useMoverPreview } from './moverPreview';

/**
 * The earner preview's two facts that live OUTSIDE its own screens.
 *
 * While a rider or driver previews their dashboard, the app's API client
 * refuses every write (lib/previewWriteGuard) — they may be signed in for
 * real, and nothing the sample does may reach their account. That is only
 * right while the preview is what they are looking at. The moment something
 * takes them out of it to real things — a store link, a printed QR code, a
 * notification, a payment return, another app's screen — the preview must
 * end, or their real cart, checkout, tip or support request is refused as "a
 * preview" [DS624 S2].
 */

/** The preview is on screen: its flag is set AND the mover app is the one open. */
export function moverPreviewShowing(): boolean {
  return useMoverPreview.getState().preview && useAuthStore.getState().intent === 'mover';
}

/**
 * End the preview the way it was entered, whoever asks: its own "Back to my
 * documents" / "Exit preview", or a link, tap or screen that leaves it. From
 * the documents the mover app is the person's own and stays open (on their
 * documents); from the welcome screen it was only ever the sample, so the
 * welcome screen comes back. Answers whether a preview was ended.
 */
export function leaveMoverPreview(): boolean {
  const { preview, origin, exitPreview } = useMoverPreview.getState();
  if (!preview) return false;
  exitPreview();
  const auth = useAuthStore.getState();
  if (origin !== 'documents' && auth.intent === 'mover') auth.setIntent(null);
  return true;
}
