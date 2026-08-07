/** @jsxImportSource react */
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { PROVIDER_DEFAULT, type Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { color, space } from '@swift/ui';
import { useLocationStore } from '../../../stores/locationStore';
import { GEORGETOWN } from '../../../hooks/useDeviceLocation';
import { CircleChip, PillButton, PinGlyph, T } from '../../../kit';
import type { PickedPlace } from './DestinationSearchScreen';

/**
 * Drag-the-map pin confirm. The pin is fixed at screen centre; panning the map
 * moves the underlying point. On confirm we reverse-geocode a label with the OS
 * geocoder (no API key) and hand the point back via the `onSelect` route param.
 */
export function PinConfirmScreen({ navigation, route }: any) {
  const onSelect: (place: PickedPlace) => void = route?.params?.onSelect ?? (() => {});
  const title: string = route?.params?.title ?? 'Set location';
  const insets = useSafeAreaInsets();

  const { latitude, longitude, status: locationStatus } = useLocationStore();
  const start = {
    latitude: latitude ?? GEORGETOWN.latitude,
    longitude: longitude ?? GEORGETOWN.longitude,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
  };

  const centerRef = useRef({ latitude: start.latitude, longitude: start.longitude });
  const [confirming, setConfirming] = useState(false);

  const onRegionChangeComplete = (region: Region) => {
    centerRef.current = { latitude: region.latitude, longitude: region.longitude };
  };

  const confirm = async () => {
    setConfirming(true);
    const { latitude: lat, longitude: lng } = centerRef.current;
    let label = 'Dropped pin';
    try {
      const [place] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      if (place) {
        label = [place.name ?? place.street, place.city ?? place.subregion].filter(Boolean).join(', ') || label;
      }
    } catch {
      // Best-effort label; the coordinate is what matters.
    } finally {
      setConfirming(false);
    }
    onSelect({ lat, lng, label });
    navigation?.goBack?.();
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        initialRegion={start}
        onRegionChangeComplete={onRegionChangeComplete}
        showsUserLocation={locationStatus === 'granted'}
      />

      {/* Floating header over the map (kit hero-chip language) */}
      <View
        style={{
          position: 'absolute',
          top: insets.top + space.sm,
          left: space['2xl'],
          right: space['2xl'],
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
        }}
      >
        <CircleChip icon="chevron-left" onPress={() => navigation?.goBack?.()} />
        <View
          style={{
            paddingHorizontal: space.lg,
            height: 44,
            borderRadius: 9999,
            backgroundColor: color.surface.base,
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: color.border.subtle,
          }}
        >
          <T variant="label" weight="semibold">
            {title}
          </T>
        </View>
      </View>

      {/* Fixed centre pin — the map slides underneath it. */}
      <View style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ marginBottom: 46 }}><PinGlyph size={46} color={color.brand[500]} /></View>
      </View>

      {/* Confirm bar */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: color.surface.base,
          borderTopWidth: 1,
          borderTopColor: color.border.subtle,
          paddingHorizontal: space['2xl'],
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space.lg,
          gap: space.md,
        }}
      >
        <T variant="label" tone="muted" center>
          Move the map to place the pin, then confirm.
        </T>
        <PillButton label="Confirm location" loading={confirming} onPress={confirm} />
      </View>
    </View>
  );
}
