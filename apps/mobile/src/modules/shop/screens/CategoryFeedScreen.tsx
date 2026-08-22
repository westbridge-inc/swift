/** @jsxImportSource react */
import React from 'react';
import { FlatList, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useDiscoveryCategories, useVendors } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { vendorPhoto } from '../../../lib/images';
import { Chip, EmptyState, ErrorState, Header, LoadingBlock, RatingMeta, Screen, T, VendorRow } from '../../../kit';

// ---------------------------------------------------------------------------
// The category feed (#17 6.3): chip tap lands here. The EXISTING store-list
// pipeline (+category param) feeds it — open stores first, closed under a
// quiet honest divider; DISH/DIETARY/AISLE cards carry "{n} items"; the empty
// state (availability changed mid-session) offers sibling categories that DO
// have someone open. Tapping a store opens the normal storefront.
// ---------------------------------------------------------------------------

export function CategoryFeedScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { slug, name, emoji } = route.params as { slug: string; name: string; emoji: string };
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);

  const vendorsQ = useVendors<any>({
    category: slug,
    ...(locationFix ? { lat: String(locationFix.latitude), lng: String(locationFix.longitude) } : {}),
  });
  const rail = useDiscoveryCategories(locationFix?.latitude, locationFix?.longitude);

  const vendors: any[] = vendorsQ.data?.data ?? vendorsQ.data ?? [];
  const open = vendors.filter((v) => v.isCurrentlyOpen);
  const closed = vendors.filter((v) => !v.isCurrentlyOpen);
  const siblings = (rail.data?.categories ?? []).filter((c) => c.slug !== slug).slice(0, 3);

  const row = (v: any) => (
    <VendorRow
      image={vendorPhoto(v)}
      name={v.name}
      meta={
        <RatingMeta
          rating={v.displayRating ?? null}
          bucket={v.ratingBucket}
          topRated={v.topRated}
          extra={locationFix && v.distanceKm != null ? `${v.distanceKm} km` : undefined}
        />
      }
      sub={v.itemsInCategory ? `${v.itemsInCategory} ${name.toLowerCase()} items` : v.etaMin ? `~${v.etaMin} min delivery` : undefined}
      onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
    />
  );

  return (
    <Screen>
      <Header title={`${emoji} ${name}`} />
      {vendorsQ.isLoading ? (
        <LoadingBlock />
      ) : vendorsQ.isError ? (
        <ErrorState onRetry={() => vendorsQ.refetch()} />
      ) : vendors.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="clock"
            title={`No ${name.toLowerCase()} spots are open right now`}
            body="Check back soon."
          />
          {siblings.length > 0 ? (
            <View style={{ alignItems: 'center', paddingBottom: space['3xl'] }}>
              <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
                Open now instead
              </T>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                {siblings.map((c) => (
                  <Chip
                    key={c.slug}
                    label={`${c.emoji} ${c.name}`}
                    onPress={() => navigation.setParams({ slug: c.slug, name: c.name, emoji: c.emoji })}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={[...open, ...closed]}
          keyExtractor={(v) => v.id}
          contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: space.md, paddingBottom: space['3xl'] }}
          renderItem={({ item: v, index }) => (
            <>
              {index === open.length && closed.length > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginVertical: space.sm }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: color.border.subtle }} />
                  <T variant="caption" tone="muted">Closed now</T>
                  <View style={{ flex: 1, height: 1, backgroundColor: color.border.subtle }} />
                </View>
              ) : null}
              {row(v)}
            </>
          )}
        />
      )}
    </Screen>
  );
}
