import { useState } from 'react';
import { View, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, Spinner, PressableScale, Input, EmptyState } from '../../../components/ui';
import { useAddresses } from '../../../hooks';
import { usePlacesAutocomplete, usePlaceDetails } from '../../../hooks/usePlacesAutocomplete';
import { useLocationStore } from '../../../stores/locationStore';
import type { PlaceSuggestion } from '../../../services/api';

// What every place picker hands back to its caller.
export type PickedPlace = { lat: number; lng: number; label: string; placeId?: string };

/**
 * "Where to?" destination search. Suggestions come from the server-side Places
 * seam (proximity-biased on current location), with the user's saved addresses
 * and a "Set on map" pin option as shortcuts. Returns the choice to the caller
 * via the `onSelect` route param.
 */
export function DestinationSearchScreen({ navigation, route }: any) {
  const onSelect: (place: PickedPlace) => void = route?.params?.onSelect ?? (() => {});
  const title: string = route?.params?.title ?? 'Where to?';

  const { latitude, longitude } = useLocationStore();
  const near = latitude != null && longitude != null ? { lat: latitude, lng: longitude } : undefined;

  const [query, setQuery] = useState('');
  const { data: suggestions, isFetching } = usePlacesAutocomplete(query, near);
  const resolveDetails = usePlaceDetails();
  const { data: addresses } = useAddresses<any[]>();

  const [resolving, setResolving] = useState(false);
  const savedList = addresses ?? [];
  const showSaved = query.trim().length < 2;

  const choose = (place: PickedPlace) => {
    onSelect(place);
    navigation?.goBack?.();
  };

  const pickSuggestion = async (s: PlaceSuggestion) => {
    setResolving(true);
    try {
      const detail = await resolveDetails(s.placeId);
      if (detail) choose({ lat: detail.lat, lng: detail.lng, label: detail.label, placeId: detail.placeId });
    } finally {
      setResolving(false);
    }
  };

  const openPin = () => {
    navigation?.navigate?.('PinConfirm', { onSelect: choose, title });
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md text-base font-bold">{title}</Text>
      </View>

      <View className="px-lg pb-sm">
        <Input
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Search a place or address"
          left={<Feather name="search" size={18} color={color.text.muted} />}
          right={
            query.length > 0 ? (
              <PressableScale onPress={() => setQuery('')} hitSlop={8}>
                <Feather name="x-circle" size={18} color={color.text.muted} />
              </PressableScale>
            ) : resolving || isFetching ? (
              <Spinner />
            ) : null
          }
        />
      </View>

      <PressableScale onPress={openPin}>
        <View className="mx-lg mb-sm flex-row items-center rounded-xl border border-border-subtle bg-surface-subtle px-lg py-md">
          <MaterialCommunityIcons name="map-marker-radius-outline" size={20} color={color.brand[500]} />
          <Text className="ml-sm font-semibold text-brand-600">Set location on map</Text>
        </View>
      </PressableScale>

      {showSaved ? (
        <FlatList
          data={savedList}
          keyExtractor={(a) => a.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          ListHeaderComponent={
            savedList.length > 0 ? (
              <Text className="mb-sm mt-xs text-xs font-semibold uppercase text-text-muted">Saved places</Text>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="map-marker-outline"
              title="Search for a destination"
              body="Type a place or address above, or set a point on the map."
            />
          }
          renderItem={({ item: a }) => (
            <PressableScale
              onPress={() =>
                choose({ lat: a.latitude, lng: a.longitude, label: a.label || a.addressLine1 })
              }
            >
              <Card className="mb-sm flex-row items-center">
                <MaterialCommunityIcons name="map-marker-outline" size={20} color={color.text.muted} />
                <View className="ml-sm flex-1">
                  <Text className="text-base font-semibold">{a.label || a.addressLine1}</Text>
                  <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                    {a.addressLine1}
                    {a.city ? `, ${a.city}` : ''}
                  </Text>
                </View>
              </Card>
            </PressableScale>
          )}
        />
      ) : (
        <FlatList
          data={suggestions ?? []}
          keyExtractor={(s) => s.placeId}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          ListEmptyComponent={
            isFetching ? null : (
              <EmptyState icon="magnify" title="No matches" body="Try a different place, or set it on the map." />
            )
          }
          renderItem={({ item: s }) => (
            <PressableScale onPress={() => pickSuggestion(s)}>
              <Card className="mb-sm flex-row items-center">
                <Feather name="map-pin" size={18} color={color.text.muted} />
                <View className="ml-sm flex-1">
                  <Text className="text-base font-semibold">{s.primary}</Text>
                  {s.secondary ? (
                    <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                      {s.secondary}
                    </Text>
                  ) : null}
                </View>
              </Card>
            </PressableScale>
          )}
        />
      )}
    </SafeAreaView>
  );
}
