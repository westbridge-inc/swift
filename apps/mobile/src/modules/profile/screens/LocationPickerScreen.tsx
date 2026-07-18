/** @jsxImportSource react */
import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import MapView, { type Region } from 'react-native-maps';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@swift/ui';
import { useLocationStore } from '../../../stores/locationStore';
import { CircleChip, PillButton, T } from '../../../kit';

// Center-pin map picker: pan the map, the fixed pin marks the spot, Confirm
// returns the coordinate to the caller via merged navigation params.
export function LocationPickerScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { latitude, longitude } = useLocationStore();

  const initial = route.params?.initial as { latitude: number; longitude: number } | undefined;
  const returnTo: string = route.params?.returnTo ?? 'AddAddress';

  const start: Region = {
    latitude: initial?.latitude ?? latitude ?? 6.8013,
    longitude: initial?.longitude ?? longitude ?? -58.1551, // Georgetown fallback
    latitudeDelta: 0.01,
    longitudeDelta: 0.01,
  };
  const [region, setRegion] = useState<Region>(start);
  const mapRef = useRef<MapView>(null);

  const confirm = () =>
    navigation.navigate({
      name: returnTo,
      params: { picked: { latitude: region.latitude, longitude: region.longitude } },
      merge: true,
    });

  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={start}
        onRegionChangeComplete={setRegion}
        showsUserLocation
      />

      {/* Fixed center pin */}
      <View style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ marginBottom: 36, alignItems: 'center' }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: color.brand[500],
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 3,
              borderColor: color.white,
            }}
          >
            <Feather name="map-pin" size={18} color={color.white} />
          </View>
          <View style={{ width: 3, height: 14, backgroundColor: color.brand[600], borderRadius: 2 }} />
        </View>
      </View>

      {/* Header + confirm */}
      <View style={{ position: 'absolute', top: insets.top + space.sm, left: space['2xl'] }}>
        <CircleChip icon="chevron-left" onPress={() => navigation.goBack()} />
      </View>
      <View
        style={{
          position: 'absolute',
          left: space['2xl'],
          right: space['2xl'],
          bottom: insets.bottom + space.lg,
          gap: space.sm,
        }}
      >
        <View
          style={{
            alignSelf: 'center',
            backgroundColor: color.surface.base,
            borderRadius: 9999,
            paddingHorizontal: space.lg,
            paddingVertical: 6,
          }}
        >
          <T variant="caption" tone="muted">
            {region.latitude.toFixed(5)}, {region.longitude.toFixed(5)}
          </T>
        </View>
        <PillButton label="Confirm Pin" onPress={confirm} />
      </View>
    </View>
  );
}
