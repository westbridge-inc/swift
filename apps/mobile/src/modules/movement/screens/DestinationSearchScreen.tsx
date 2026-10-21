/** @jsxImportSource react */
import React, { useRef, useState } from 'react';
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
  const { data: suggestions, isFetching, isError: searchFailed, refetch: searchAgain } = usePlacesAutocomplete(query, near);
  const resolveDetails = usePlaceDetails();
  const { data: addresses } = useAddresses<any[]>();

  // The suggestion being opened (its name shows while the lookup runs).
  const [resolving, setResolving] = useState<string | null>(null);
  // [UI-SWEEP U69] A place that could not be opened says so, here.
  const [pickError, setPickError] = useState<string | null>(null);
  // [UI-SWEEP U68] One place is chosen, once: a second tap while the first
  // is still opening (or after it was chosen) neither chooses again nor goes
  // back a second time, which used to close the Taxi screen too.
  const picking = useRef(false);
  const chosen = useRef(false);
  const savedList = addresses ?? [];
  const showSaved = query.trim().length < 2;

  const choose = (place: PickedPlace) => {
    if (chosen.current) return;
    chosen.current = true;
    onSelect(place);
    navigation?.goBack?.();
  };

  const pickSuggestion = async (s: PlaceSuggestion) => {
    if (picking.current || chosen.current) return;
    picking.current = true;
    setPickError(null);
    setResolving(s.primary);
    try {
      const detail = await resolveDetails(s.placeId);
      // [#1940 review S3-1] An answer that lands after the rider moved on
      // ("Set location on map", or Back) is dropped: choosing it then would
      // pop the map screen instead of this one and leave this screen dead.
      if (navigation?.isFocused?.() === false) return;
      if (detail) choose({ lat: detail.lat, lng: detail.lng, label: detail.label, placeId: detail.placeId });
      else setPickError('That place could not be opened. Try another, or set it on the map.');
    } catch {
      setPickError('That place could not be opened. Check your connection and try again, or set it on the map.');
    } finally {
      picking.current = false;
      setResolving(null);
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
          onChangeText={(next: string) => {
            // [#1940 review S4-2] A new search clears the old place's error.
            setPickError(null);
            setQuery(next);
          }}
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
          ListHeaderComponent={
            pickError ? (
              <T variant="label" tone="error" style={{ marginBottom: space.md }}>
                {pickError}
              </T>
            ) : resolving ? (
              // [#1940 review S4-1] The tap registered: say which place is opening.
              <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
                {`Opening ${resolving}…`}
              </T>
            ) : null
          }
          ListEmptyComponent={
            // [UI-SWEEP U70] "No matches" only once the search has answered
            // with nothing. A failed search says so and offers Try again; a
            // search that has not answered yet claims nothing.
            searchFailed && !isFetching ? (
              <EmptyState
                icon="wifi-off"
                title="Search is not working right now"
                body="Check your connection and try again, or set the place on the map."
                actionLabel="Try again"
                onAction={() => searchAgain()}
              />
            ) : isFetching || !Array.isArray(suggestions) ? (
              // [#1940 review S4-1] A search that has not answered says it is searching.
              <T variant="label" tone="muted">
                Searching…
              </T>
            ) : (
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
