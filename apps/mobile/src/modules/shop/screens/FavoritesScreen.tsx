/** @jsxImportSource react */
import React from 'react';
import { Dimensions, FlatList } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { space } from '@swift/ui';
import { useFavorites, useToggleFavorite } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { vendorPhoto } from '../../../lib/images';
import { EmptyState, ErrorState, FoodCard, Header, LoadingBlock, Screen } from '../../../kit';

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const CARD_W = (SCREEN_W - GUTTER * 2 - space.lg) / 2;

export function FavoritesScreen() {
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin } = useAuthStore();
  const favorites = useFavorites<any>();
  const toggleFav = useToggleFavorite();

  if (!isAuthenticated) {
    return (
      <Screen>
        <Header title="Favorites" />
        <EmptyState icon="heart" title="Sign in to save favorites" actionLabel="Sign In" onAction={promptLogin} />
      </Screen>
    );
  }

  const rows: any[] = Array.isArray(favorites.data) ? favorites.data : (favorites.data?.vendors ?? []);

  return (
    <Screen>
      <Header title="Favorites" />
      {favorites.isLoading ? (
        <LoadingBlock />
      ) : favorites.isError ? (
        <ErrorState onRetry={() => favorites.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="heart"
          title="Nothing saved yet"
          body="Tap the heart on any store to keep it here."
          actionLabel="Browse Stores"
          onAction={() => navigation.navigate('Search')}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(v) => v.id}
          numColumns={2}
          columnWrapperStyle={{ gap: space.lg, paddingHorizontal: GUTTER }}
          contentContainerStyle={{ gap: space.lg, paddingTop: space.md, paddingBottom: space['3xl'] }}
          renderItem={({ item: v }) => (
            <FoodCard
              width={CARD_W}
              image={vendorPhoto(v)}
              name={v.name}
              rating={v.displayRating ?? null}
              ratingBucket={v.ratingBucket}
              topRated={v.topRated}
              favorite
              onToggleFavorite={() => toggleFav.mutate({ vendorId: v.id, isFavorite: true })}
              onPress={() => navigation.navigate('Restaurant', { vendorId: v.id })}
            />
          )}
        />
      )}
    </Screen>
  );
}
