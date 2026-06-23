import { useRef, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { PROVIDER_DEFAULT, type Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Button, PressableScale } from '../../components/ui';
import { useLocationStore } from '../../stores/locationStore';
import { GEORGETOWN } from '../../hooks/useDeviceLocation';
import type { PickedPlace } from './DestinationSearchScreen';

/**
 * Drag-the-map pin confirm. The pin is fixed at screen centre; panning the map
 * moves the underlying point. On confirm we reverse-geocode a label with the OS
 * geocoder (no API key) and hand the point back via the `onSelect` route param.
 */
export function PinConfirmScreen({ navigation, route }: any) {
  const onSelect: (place: PickedPlace) => void = route?.params?.onSelect ?? (() => {});
  const title: string = route?.params?.title ?? 'Set location';

  const { latitude, longitude } = useLocationStore();
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
        label =
          [place.name ?? place.street, place.city ?? place.subregion].filter(Boolean).join(', ') || label;
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="absolute left-0 right-0 top-0 z-10 flex-row items-center px-lg pt-2xl">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <View className="h-10 w-10 items-center justify-center rounded-full bg-surface-base" style={{ elevation: 3 }}>
            <Feather name="chevron-left" size={22} color={color.text.primary} />
          </View>
        </PressableScale>
        <Text className="ml-md text-base font-bold">{title}</Text>
      </View>

      <MapView
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        initialRegion={start}
        onRegionChangeComplete={onRegionChangeComplete}
        showsUserLocation
      />

      {/* Fixed centre pin — the map slides underneath it. */}
      <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
        <MaterialCommunityIcons name="map-marker" size={44} color={color.brand[500]} style={{ marginBottom: 44 }} />
      </View>

      <View className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-base px-lg pb-2xl pt-md">
        <Text className="mb-sm text-center text-sm text-text-secondary">
          Move the map to place the pin, then confirm.
        </Text>
        <Button loading={confirming} onPress={confirm}>
          <Text className="font-body font-semibold text-white">Confirm location</Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
