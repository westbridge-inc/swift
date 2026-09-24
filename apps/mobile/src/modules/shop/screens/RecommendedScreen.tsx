/** @jsxImportSource react */
import React from 'react';
import { Dimensions, FlatList } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { space } from '@swift/ui';
import { useHome, useToggleFavorite } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { vendorPhoto } from '../../../lib/images';
import { CartBar, useCartBarClearance, EmptyState, ErrorState, FoodCard, Header, LoadingBlock, Screen } from '../../../kit';

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const CARD_W = (SCREEN_W - GUTTER * 2 - space.lg) / 2;

// Kit frame 12 — the full "Recommended Restaurant" grid.
export function RecommendedScreen() {
  // [E09] While the cart bar floats over the list, the last row must scroll clear of it.
  const cartClearance = useCartBarClearance();
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin } = useAuthStore();
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);
  const home = useHome<any>(locationFix?.latitude, locationFix?.longitude);
  const toggleFav = useToggleFavorite();

  const featured: any[] = home.data?.featured ?? [];
  const open: any[] = home.data?.openVendors ?? [];
  const seen = new Set(featured.map((v) => v.id));
  const vendors = [...featured, ...open.filter((v) => !seen.has(v.id))];

  return (
    <Screen>
      <Header title="Recommended" />
      {home.isLoading ? (
        <LoadingBlock />
      ) : home.isError ? (
        <ErrorState onRetry={() => home.refetch()} />
      ) : vendors.length === 0 ? (
        <EmptyState icon="coffee" title="Nothing open right now" body="Come back soon — stores set their own hours." />
      ) : (
        <FlatList
          data={vendors}
          keyExtractor={(v) => v.id}
          numColumns={2}
          columnWrapperStyle={{ gap: space.lg, paddingHorizontal: GUTTER }}
          contentContainerStyle={{ gap: space.lg, paddingTop: space.md, paddingBottom: space['3xl'] + cartClearance }}
          renderItem={({ item: v }) => (
            <FoodCard
              width={CARD_W}
              image={vendorPhoto(v)}
              name={v.name}
              rating={v.displayRating ?? null}
              ratingBucket={v.ratingBucket}
              topRated={v.topRated}
              meta={v.etaMin ? `${v.etaMin} min` : undefined}
              favorite={v.isFavorite}
              onToggleFavorite={() =>
                isAuthenticated ? toggleFav.mutate({ vendorId: v.id, isFavorite: !!v.isFavorite }) : promptLogin()
              }
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
