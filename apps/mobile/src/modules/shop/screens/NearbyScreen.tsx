/** @jsxImportSource react */
import React from 'react';
import { FlatList, Linking } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { space } from '@swift/ui';
import { useHome } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { useDeviceLocation } from '../../../hooks/useDeviceLocation';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { distanceLabel } from '../../../lib/geo';
import { vendorPhoto } from '../../../lib/images';
import { CartBar, useCartBarClearance, EmptyState, ErrorState, Header, LoadingBlock, RatingMeta, Screen, VendorRow } from '../../../kit';

// Kit frame 13 — "Nearby Restaurant" list. Real proximity only: without a
// location fix we say so instead of faking distances.
export function NearbyScreen() {
  // [E09] While the cart bar floats over the list, the last row must scroll clear of it.
  const cartClearance = useCartBarClearance();
  const navigation = useNavigation<any>();
  const { latitude, longitude, status } = useLocationStore();
  const { resolve: requestLocation } = useDeviceLocation({ refreshOnMount: false });
  const locationFix = grantedLocationFix(latitude, longitude, status);
  const home = useHome<any>(locationFix?.latitude, locationFix?.longitude);

  const nearby: any[] = locationFix ? (home.data?.nearby ?? []) : [];
  const noLocation = locationFix === null;

  return (
    <Screen>
      <Header title="Nearby" />
      {noLocation ? (
        <EmptyState
          icon="map-pin"
          title={status === 'denied' ? 'Location is off' : 'See what’s nearby'}
          body={
            status === 'denied'
              ? 'Turn on location to see what’s close. You can keep browsing without it.'
              : status === 'resolving'
                ? 'Finding your location. You can keep browsing while we look.'
              : 'Use your location to find stores around you. You can keep browsing without it.'
          }
          actionLabel={status === 'resolving' ? undefined : status === 'denied' ? 'Open settings' : 'Use my location'}
          onAction={status === 'resolving'
            ? undefined
            : () => {
                if (status === 'denied') void Linking.openSettings();
                else void requestLocation();
              }}
        />
      ) : home.isLoading ? (
        <LoadingBlock />
      ) : home.isError ? (
        <ErrorState onRetry={() => home.refetch()} />
      ) : nearby.length === 0 ? (
        <EmptyState icon="map" title="Nothing close by yet" body="No open stores within 5 km of you right now." />
      ) : (
        <FlatList
          data={nearby}
          keyExtractor={(v) => v.id}
          contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: space.md, paddingBottom: space['3xl'] + cartClearance }}
          renderItem={({ item: v }) => (
            <VendorRow
              image={vendorPhoto(v)}
              name={v.name}
              meta={
                <RatingMeta
                  rating={v.displayRating ?? null}
                  bucket={v.ratingBucket}
                  topRated={v.topRated}
                  extra={distanceLabel(v.distanceKm)}
                />
              }
              sub={v.etaMin ? `~${v.etaMin} min delivery` : undefined}
              onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
            />
          )}
        />
      )}
      {/* [E09] A shopper who has added items can always reach the Cart tab. */}
      <CartBar />
    </Screen>
  );
}
