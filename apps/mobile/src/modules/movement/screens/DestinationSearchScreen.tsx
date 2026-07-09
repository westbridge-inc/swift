/** @jsxImportSource react */
import React, { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { useAddresses } from '../../../hooks';
import { usePlacesAutocomplete, usePlaceDetails } from '../../../hooks/usePlacesAutocomplete';
import { useLocationStore } from '../../../stores/locationStore';
import type { PlaceSuggestion } from '../../../services/api';
import { Card, EmptyState, Header, IconChip, LabeledInput, Screen, T } from '../../../kit';

// What every place picker hands back to its caller.
export type PickedPlace = { lat: number; lng: number; label: string; placeId?: string };

/** Kit place row: icon chip · primary + secondary lines. */
function PlaceRow({
  icon,
  primary,
  secondary,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  primary: string;
  secondary?: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md, opacity: pressed ? 0.8 : 1 }}>
          <IconChip icon={icon} />
          <View style={{ flex: 1 }}>
            <T variant="body" weight="semibold" numberOfLines={1}>
              {primary}
            </T>
            {secondary ? (
              <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                {secondary}
              </T>
            ) : null}
          </View>
          <Feather name="chevron-right" size={18} color={color.text.muted} />
        </Card>
      )}
    </Pressable>
  );
}

/**
 * "Where to?" destination search (kit 57-style list). Suggestions come from the
 * server-side Places seam (proximity-biased), with saved addresses and a
 * "Set on map" pin as shortcuts. Returns the choice via the `onSelect` param.
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

  return (
    <Screen>
      <Header title={title} />
      <View style={{ paddingHorizontal: space['2xl'], paddingTop: space.sm }}>
        <LabeledInput
          autoFocus
          icon="search"
          placeholder="Search a place or address"
          value={query}
          onChangeText={setQuery}
          right={
            query.length > 0 ? (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <View style={{ padding: 4 }}>
                  <Feather name="x-circle" size={18} color={color.text.muted} />
                </View>
              </Pressable>
            ) : resolving || isFetching ? (
              <Feather name="loader" size={18} color={color.text.muted} />
            ) : null
          }
        />

        {/* Set-on-map shortcut */}
        <Pressable onPress={() => navigation?.navigate?.('PinConfirm', { onSelect: choose, title })}>
          {({ pressed }) => (
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg, opacity: pressed ? 0.8 : 1 }}>
              <IconChip icon="crosshair" />
              <T variant="body" weight="semibold" tone="brand" style={{ flex: 1 }}>
                Set location on map
              </T>
              <Feather name="chevron-right" size={18} color={color.text.muted} />
            </Card>
          )}
        </Pressable>
      </View>

      {showSaved ? (
        <FlatList
          data={savedList}
          keyExtractor={(a) => a.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingTop: space.lg, paddingBottom: space['3xl'] }}
          ListHeaderComponent={
            savedList.length > 0 ? (
              <T variant="label" weight="semibold" tone="muted" style={{ marginBottom: space.md }}>
                Saved places
              </T>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="map-pin"
              title="Search for a destination"
              body="Type a place or address above, or set a point on the map."
            />
          }
          renderItem={({ item: a }) => (
            <PlaceRow
              icon="map-pin"
              primary={a.label || a.addressLine1}
              secondary={`${a.addressLine1}${a.city ? `, ${a.city}` : ''}`}
              onPress={() => choose({ lat: a.latitude, lng: a.longitude, label: a.label || a.addressLine1 })}
            />
          )}
        />
      ) : (
        <FlatList
          data={suggestions ?? []}
          keyExtractor={(s) => s.placeId}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingTop: space.lg, paddingBottom: space['3xl'] }}
          ListEmptyComponent={
            isFetching ? null : (
              <EmptyState icon="search" title="No matches" body="Try a different place, or set it on the map." />
            )
          }
          renderItem={({ item: s }) => (
            <PlaceRow icon="map-pin" primary={s.primary} secondary={s.secondary} onPress={() => pickSuggestion(s)} />
          )}
        />
      )}
    </Screen>
  );
}
