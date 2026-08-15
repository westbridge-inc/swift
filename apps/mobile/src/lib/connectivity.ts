/** The one-line banner body is 6pt top + 18pt text + 8pt bottom. Keep a
 * 32pt floor for font/rendering variance; dynamic type can measure taller. */
export const OFFLINE_BANNER_MIN_BODY_HEIGHT = 32;

/** Only the portion below the status-bar safe area must move navigation down.
 * Reserving the full banner would apply the safe area twice on every screen. */
export function offlineBannerBodyHeight(measuredHeight: number, safeAreaTop: number): number {
  if (!Number.isFinite(measuredHeight) || !Number.isFinite(safeAreaTop)) {
    return OFFLINE_BANNER_MIN_BODY_HEIGHT;
  }
  return Math.max(
    OFFLINE_BANNER_MIN_BODY_HEIGHT,
    Math.ceil(Math.max(0, measuredHeight) - Math.max(0, safeAreaTop)),
  );
}
