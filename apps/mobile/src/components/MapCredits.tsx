/** @jsxImportSource react */
import { Platform, View } from 'react-native';
import { color, space } from '@swift/ui';
import { T } from '../kit';
import { openExternal } from '../lib/openExternal';

/** Supplement native SDK labels; never replace or hide their attribution. */
export function MapCredits({ routeSource }: { routeSource?: 'osrm' | 'haversine' } = {}) {
  const provider = Platform.OS === 'ios'
    ? { label: 'Apple Maps', url: 'https://www.apple.com/legal/internet-services/maps/' }
    : Platform.OS === 'android'
      ? { label: 'Google Maps', url: 'https://www.google.com/intl/en/help/terms_maps/' }
      : null;
  const linkStyle = { color: color.attribution.text, letterSpacing: 0, fontStyle: 'normal' as const };
  return (
    <View style={{ backgroundColor: color.surface.base, paddingHorizontal: space.md, paddingVertical: space.xs, alignItems: 'center', gap: space.xs }}>
      {provider ? (
        <T variant="caption" weight="regular" numberOfLines={1} maxFontSizeMultiplier={16 / 13}
          style={linkStyle} accessibilityRole="link" accessibilityLabel={'Map provider: ' + provider.label}
          onPress={() => { void openExternal(provider.url, 'Could not open map-provider information.'); }}>
          {provider.label}
        </T>
      ) : null}
      {routeSource === 'osrm' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm }}>
          <T variant="caption" weight="regular" style={linkStyle} accessibilityRole="link"
            onPress={() => { void openExternal('https://project-osrm.org/', 'Could not open routing information.'); }}>
            Routing: OSRM
          </T>
          <T variant="caption" weight="regular" style={linkStyle} accessibilityRole="link"
            onPress={() => { void openExternal('https://www.openstreetmap.org/copyright', 'Could not open map-data information.'); }}>
            © OpenStreetMap contributors
          </T>
        </View>
      ) : null}
    </View>
  );
}
