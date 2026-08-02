import type { RefObject } from 'react';
import type MapView from 'react-native-maps';

// Ride camera choreography [rides spec 6.1] — ALL camera moves go through
// this one controller so behavior is consistent and testable. The sheet is
// the map's permanent neighbor: every fit uses asymmetric padding so nothing
// hides under it, and detent changes re-fire the last fit (debounced). A user
// pan sets userOverride (auto moves suspend, the recenter FAB appears);
// clearing it or changing ride state resumes control.

export interface LatLng { latitude: number; longitude: number }

const CAMERA_MS = 700; // 600–800ms ease per motion tokens

/** Pure: the asymmetric padding for a given sheet height [6.1]. */
export function fitPadding(sheetHeightPx: number) {
  return { top: 80, left: 48, right: 48, bottom: Math.max(40, Math.round(sheetHeightPx) + 40) };
}

/** Pure: should trackApproach re-fit? Only when the driver has left the
 *  currently-fitted view — no seasick constant re-fitting [6.1]. */
export function outsideBounds(p: LatLng, bounds: { northEast: LatLng; southWest: LatLng } | null): boolean {
  if (!bounds) return true;
  const margin = 0.0008; // ~90m hysteresis so edge jitter doesn't thrash
  return (
    p.latitude > bounds.northEast.latitude - margin ||
    p.latitude < bounds.southWest.latitude + margin ||
    p.longitude > bounds.northEast.longitude - margin ||
    p.longitude < bounds.southWest.longitude + margin
  );
}

export class RideCamera {
  private lastFit: { coords: LatLng[]; sheetHeightPx: number } | null = null;
  private fitTimer: ReturnType<typeof setTimeout> | null = null;
  private fittedBounds: { northEast: LatLng; southWest: LatLng } | null = null;
  userOverride = false;

  constructor(private map: RefObject<MapView | null>) {}

  /** ROUTE_PREVIEW / MATCHED: fit pickup+dest (or any coord set) above the sheet. */
  fitRoute(coords: LatLng[], sheetHeightPx: number) {
    if (this.userOverride || coords.length === 0) return;
    this.lastFit = { coords, sheetHeightPx };
    this.map.current?.fitToCoordinates(coords, {
      edgePadding: fitPadding(sheetHeightPx),
      animated: true,
    });
    this.captureBounds();
  }

  /** Detent changed: re-fire the last fit with the new sheet height, debounced 150ms. */
  onSheetHeight(sheetHeightPx: number) {
    if (!this.lastFit || this.userOverride) return;
    this.lastFit.sheetHeightPx = sheetHeightPx;
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      if (this.lastFit) this.fitRoute(this.lastFit.coords, this.lastFit.sheetHeightPx);
    }, 150);
  }

  /** REQUESTING: center the pickup, close in. */
  focusPickup(pickup: LatLng) {
    if (this.userOverride) return;
    this.lastFit = null;
    this.map.current?.animateCamera({ center: pickup, zoom: 16.5 }, { duration: CAMERA_MS });
  }

  /** DRIVER_EN_ROUTE: fit driver+pickup; re-fit only when the driver exits view. */
  trackApproach(driver: LatLng, pickup: LatLng, sheetHeightPx: number) {
    if (this.userOverride) return;
    if (!outsideBounds(driver, this.fittedBounds)) return;
    this.fitRoute([driver, pickup], sheetHeightPx);
  }

  /** IN_TRIP: driver-centered follow, bearing-up, anchored above the peek bar. */
  followTrip(driver: LatLng, headingDeg: number | null | undefined) {
    if (this.userOverride) return;
    this.lastFit = null;
    this.map.current?.animateCamera(
      { center: driver, zoom: 16, heading: headingDeg ?? 0 },
      { duration: CAMERA_MS },
    );
  }

  /** User panned: suspend auto moves; the screen shows the recenter FAB. */
  setUserOverride(on: boolean) {
    this.userOverride = on;
    if (!on && this.lastFit) this.fitRoute(this.lastFit.coords, this.lastFit.sheetHeightPx);
  }

  private captureBounds() {
    // Best-effort; bounds feed the approach hysteresis only.
    this.map.current
      ?.getMapBoundaries?.()
      .then((b) => { this.fittedBounds = b; })
      .catch(() => undefined);
  }
}
