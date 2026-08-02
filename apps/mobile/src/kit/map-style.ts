// The rides map style [rides spec 3.6] — the single biggest bland→premium
// lever. Design intent: the map and the sheet read as ONE material — land
// matches the app's warm off-white, roads are a warm-grey hierarchy with
// legible street names (Georgetown navigates by street name), the Demerara
// reads calm slate — not Google-blue — and POI icon noise is gone while
// transit + hospitals stay. Night mirrors it in ink-navy. Versioned asset:
// bump RIDE_MAP_STYLE_VERSION whenever a styler changes so snapshot baselines
// know to re-shoot.
//
// Reality note (recon 1.3): customMapStyle is a GOOGLE renderer feature —
// live on Android today. iOS runs Apple Maps (PROVIDER_DEFAULT, no key);
// there it no-ops silently and the honest wins are the POI/traffic props in
// rideMapProps(). Google-on-iOS is a founder option riding the next native
// rebuild (needs an iOS Maps key) — logged in the recon report.

import type { ComponentProps } from 'react';
import type MapView from 'react-native-maps';

export const RIDE_MAP_STYLE_VERSION = 1;

type MapStyleElement = { featureType?: string; elementType?: string; stylers: Record<string, string | number | boolean>[] };

export const rideMapStyleDay: MapStyleElement[] = [
  // Base land — the sheet's warm paper, one material with the app.
  { elementType: 'geometry', stylers: [{ color: '#F3F0EB' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#786C6C' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#FBFBF9' }, { weight: 2 }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },

  // POI: icon noise off; keep the two kinds a rider navigates by.
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.medical', elementType: 'labels.text', stylers: [{ visibility: 'on' }, { color: '#8A7070' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#E2E7DE' }] },

  // Roads: warm-grey hierarchy, names legible.
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.local', elementType: 'geometry', stylers: [{ color: '#FFFFFF' }] },
  { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#8A8078' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#F7F4EE' }] },
  { featureType: 'road.arterial', elementType: 'geometry.stroke', stylers: [{ visibility: 'on' }, { color: '#E4DFD7' }, { weight: 0.6 }] },
  { featureType: 'road.arterial', elementType: 'labels.text.fill', stylers: [{ color: '#6E645E' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#EFEAE1' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ visibility: 'on' }, { color: '#DCD5C9' }, { weight: 0.8 }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#5F564F' }] },

  // Transit: present, quiet.
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit.station', elementType: 'labels.text', stylers: [{ visibility: 'on' }, { color: '#8A8078' }] },

  // Water: the Demerara reads calm slate, never Google-blue.
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#C2CFD1' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#7C8E91' }] },

  // Boundaries and man-made fills stay out of the way.
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry.stroke', stylers: [{ color: '#E8E3DB' }, { weight: 0.5 }] },
];

export const rideMapStyleNight: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#1B1E27' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9A938E' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#14161D' }, { weight: 2 }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },

  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.medical', elementType: 'labels.text', stylers: [{ visibility: 'on' }, { color: '#A8827E' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#20262A' }] },

  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.local', elementType: 'geometry', stylers: [{ color: '#262A35' }] },
  { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#7E7873' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#2C3140' }] },
  { featureType: 'road.arterial', elementType: 'labels.text.fill', stylers: [{ color: '#8E8781' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#353B4D' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#9C948D' }] },

  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit.station', elementType: 'labels.text', stylers: [{ visibility: 'on' }, { color: '#7E7873' }] },

  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#10141C' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4F6266' }] },

  { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
];

/** One prop-pack for every rides MapView: the style (Google renderers) plus
 *  the honest cross-platform wins (POI/traffic/building noise off). Spread
 *  LAST so screens can't drift from the shared look. */
export function rideMapProps(scheme: string | null | undefined): Partial<ComponentProps<typeof MapView>> {
  return {
    customMapStyle: scheme === 'dark' ? rideMapStyleNight : rideMapStyleDay,
    showsPointsOfInterests: false,
    showsTraffic: false,
    showsBuildings: false,
    showsIndoors: false,
    toolbarEnabled: false,
    pitchEnabled: false,
  };
}
