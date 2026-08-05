/** @jsxImportSource react */
import React from 'react';
import { FlatList } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { space } from '@swift/ui';
import { useHome } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { vendorImage } from '../../../lib/images';
import { EmptyState, ErrorState, Header, LoadingBlock, RatingMeta, Screen, VendorRow } from '../../../kit';

// Kit frame 13 — "Nearby Restaurant" list. Real proximity only: without a
// location fix we say so instead of faking distances.
export function NearbyScreen() {
  const navigation = useNavigation<any>();
  const { latitude, longitude, status } = useLocationStore();
  const home = useHome<any>(latitude ?? undefined, longitude ?? undefined);

  const nearby: any[] = home.data?.nearby ?? [];
  const noLocation = latitude == null || longitude == null;

  return (
    <Screen>
      <Header title="Nearby" />
      {home.isLoading ? (
        <LoadingBlock />
      ) : home.isError ? (
        <ErrorState onRetry={() => home.refetch()} />
      ) : noLocation ? (
        <EmptyState
          icon="map-pin"
          title="Turn on location"
          body={
            status === 'denied'
              ? 'Location is off for Swift. Enable it in Settings to see what’s close.'
              : 'We need your position to find stores around you.'
          }
        />
      ) : nearby.length === 0 ? (
        <EmptyState icon="map" title="Nothing close by yet" body="No open stores within 5 km of you right now." />
      ) : (
        <FlatList
          data={nearby}
          keyExtractor={(v) => v.id}
          contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: space.md, paddingBottom: space['3xl'] }}
          renderItem={({ item: v }) => (
            <VendorRow
              image={vendorImage(v)}
              name={v.name}
              meta={
                <RatingMeta
                  rating={v.displayRating ?? null}
                  bucket={v.ratingBucket}
                  topRated={v.topRated}
                  extra={v.distanceKm != null ? `${v.distanceKm} km` : undefined}
                />
              }
              sub={v.etaMin ? `~${v.etaMin} min delivery` : undefined}
              onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
            />
          )}
        />
      )}
    </Screen>
  );
}
