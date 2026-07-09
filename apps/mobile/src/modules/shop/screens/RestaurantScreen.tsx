import React, { useMemo, useState } from 'react';
import { Dimensions, FlatList, Pressable, ScrollView, Share, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { useToggleFavorite, useVendor } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { DARK_BLURHASH, itemImage, vendorImage } from '../../../lib/images';
import { money } from '../../../lib/money';
import {
  CircleChip,
  ErrorState,
  FoodCard,
  HeartBadge,
  IconChip,
  LoadingBlock,
  PillButton,
  PopupCard,
  SectionHeader,
  T,
} from '../../../kit';

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];
const GRID_W = (SCREEN_W - GUTTER * 2 - space.lg) / 2;
const RAIL_W = 200;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hoursLabel(hours: any[] | undefined): string | null {
  if (!hours?.length) return null;
  const today = hours.find((h) => h.dayOfWeek === new Date().getDay());
  if (!today || today.isClosed) return 'Closed today';
  return `${today.openTime}–${today.closeTime}`;
}

/** Info-strip column: icon + value on top, muted caption beneath (kit 14). */
function StatCol({
  icon,
  value,
  caption,
  onPress,
  last = false,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  value: string;
  caption: string;
  onPress?: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={{
        flex: 1,
        borderRightWidth: last ? 0 : 1,
        borderRightColor: color.border.subtle,
        paddingHorizontal: space.sm,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Feather name={icon} size={14} color={color.warning} />
        <T variant="label" weight="semibold" numberOfLines={1}>
          {value}
        </T>
      </View>
      <T variant="caption" tone={onPress ? 'brand' : 'muted'} numberOfLines={1}>
        {caption}
      </T>
    </Pressable>
  );
}

// Kit 14–20: cover hero + floating chips, white sheet w/ name + info strip,
// promos row, Recommended/Best-seller rails, then the full menu by category.
export function RestaurantScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const vendorId: string = route.params?.vendorId;
  const { isAuthenticated, promptLogin } = useAuthStore();

  const vendor = useVendor<any>(vendorId);
  const toggleFav = useToggleFavorite();
  const [showHours, setShowHours] = useState(false);
  const [showPromos, setShowPromos] = useState(false);

  const v = vendor.data;
  const categories: any[] = useMemo(() => v?.categories ?? [], [v?.categories]);
  const allItems = useMemo(() => categories.flatMap((c: any) => c.items ?? []), [categories]);
  const recommended = useMemo(() => allItems.filter((i: any) => i.isPopular).slice(0, 8), [allItems]);
  const bestSellers = useMemo(
    () => [...allItems].sort((a: any, b: any) => (b.totalOrdered ?? 0) - (a.totalOrdered ?? 0)).slice(0, 8),
    [allItems],
  );
  const closed = v && !v.isCurrentlyOpen;
  const promos: any[] = v?.activePromos ?? [];

  if (vendor.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
        <LoadingBlock />
      </View>
    );
  }
  if (vendor.isError || !v) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        <ErrorState onRetry={() => vendor.refetch()} />
      </View>
    );
  }

  const openItem = (item: any) => navigation.navigate('MenuItem', { vendorId, itemId: item.id });

  const itemCard = (item: any, width: number) => (
    <FoodCard
      key={item.id}
      width={width}
      image={itemImage(item)}
      name={item.name}
      priceLabel={money(item.customerPrice ?? item.basePrice)}
      onPress={() => openItem(item)}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space['3xl'] }}>
        {/* Cover hero + floating chips */}
        <View>
          <Image
            source={{ uri: vendorImage(v) }}
            placeholder={{ blurhash: DARK_BLURHASH }}
            transition={200}
            style={{ width: SCREEN_W, height: 300 }}
            contentFit="cover"
          />
          <View
            style={{
              position: 'absolute',
              top: insets.top + space.sm,
              left: GUTTER,
              right: GUTTER,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <CircleChip icon="chevron-left" onPress={() => navigation.goBack()} />
            <View style={{ flex: 1 }} />
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <HeartBadge
                size={44}
                active={!!v.isFavorite}
                onPress={() =>
                  isAuthenticated ? toggleFav.mutate({ vendorId, isFavorite: !!v.isFavorite }) : promptLogin()
                }
              />
              <CircleChip
                icon="share-2"
                onPress={() => Share.share({ message: `${v.name} is on Swift — ${v.description ?? 'order in the app'}` })}
              />
            </View>
          </View>
        </View>

        {/* Sheet over the photo */}
        <View
          style={{
            marginTop: -radius.xl,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            backgroundColor: color.surface.subtle,
            paddingTop: space['2xl'],
          }}
        >
          <View style={{ paddingHorizontal: GUTTER, flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <T variant="title" style={{ flex: 1 }} numberOfLines={2}>
              {v.name}
            </T>
            {closed ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingHorizontal: space.md,
                  paddingVertical: 6,
                  borderRadius: 9999,
                  backgroundColor: '#FBEAEA',
                }}
              >
                <Feather name="clock" size={13} color={color.error} />
                <T variant="label" weight="semibold" tone="error">
                  Closed
                </T>
              </View>
            ) : null}
          </View>

          {/* Info strip */}
          <View style={{ flexDirection: 'row', paddingHorizontal: GUTTER, marginTop: space.xl }}>
            <StatCol
              icon="star"
              value={`${Number(v.averageRating ?? 0).toFixed(1)}`}
              caption="See reviews"
              onPress={() => navigation.navigate('VendorReviews', { vendorId })}
            />
            {v.distanceKm != null ? <StatCol icon="map-pin" value={`${v.distanceKm} km`} caption="Distance" /> : null}
            {v.etaMin != null ? <StatCol icon="clock" value={`${v.etaMin} min`} caption="Arrive" /> : null}
            <StatCol
              icon="clock"
              value={hoursLabel(v.operatingHours) ?? '—'}
              caption="Operational Hour"
              onPress={v.operatingHours?.length ? () => setShowHours(true) : undefined}
              last
            />
          </View>

          {/* Live promos (real active codes) */}
          {promos.length > 0 ? (
            <Pressable
              onPress={() => setShowPromos(true)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                paddingHorizontal: GUTTER,
                marginTop: space.xl,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <IconChip icon="tag" />
              <T variant="body" weight="medium" style={{ flex: 1 }}>
                {promos.length} promo{promos.length > 1 ? 's' : ''} available
              </T>
              <Feather name="chevron-right" size={20} color={color.text.muted} />
            </Pressable>
          ) : null}

          {closed ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                marginHorizontal: GUTTER,
                marginTop: space.xl,
                padding: space.lg,
                borderRadius: radius.md,
                backgroundColor: color.brand[50],
              }}
            >
              <Feather name="info" size={16} color={color.brand[600]} />
              <T variant="label" tone="deep" style={{ flex: 1 }}>
                Closed right now — browse the menu; ordering opens with the store.
              </T>
            </View>
          ) : null}

          {/* Recommended rail */}
          {recommended.length > 0 ? (
            <>
              <SectionHeader title="Recommended for you" style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }} />
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={recommended}
                keyExtractor={(i: any) => i.id}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                renderItem={({ item }) => itemCard(item, RAIL_W)}
              />
            </>
          ) : null}

          {/* Best seller rail */}
          {bestSellers.length > 0 && allItems.length > 4 ? (
            <>
              <SectionHeader title="Best seller" style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }} />
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={bestSellers}
                keyExtractor={(i: any) => `bs-${i.id}`}
                contentContainerStyle={{ paddingHorizontal: GUTTER, gap: space.lg, paddingTop: space.lg }}
                renderItem={({ item }) => itemCard(item, RAIL_W)}
              />
            </>
          ) : null}

          {/* Full menu by category */}
          {categories.map((cat: any) =>
            (cat.items?.length ?? 0) > 0 ? (
              <View key={cat.id}>
                <SectionHeader title={cat.name} style={{ paddingHorizontal: GUTTER, marginTop: space['3xl'] }} />
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    gap: space.lg,
                    paddingHorizontal: GUTTER,
                    paddingTop: space.lg,
                  }}
                >
                  {cat.items.map((item: any) => itemCard(item, GRID_W))}
                </View>
              </View>
            ) : null,
          )}

          {allItems.length === 0 ? (
            <T variant="label" tone="muted" center style={{ marginTop: space['3xl'] }}>
              This store hasn’t published a menu yet.
            </T>
          ) : null}
        </View>
      </ScrollView>

      {/* Operating hours (kit 17) */}
      <PopupCard visible={showHours} onClose={() => setShowHours(false)}>
        <IconChip icon="clock" size={56} />
        <T variant="heading" style={{ marginTop: space.md }}>
          Operational Hours
        </T>
        <View style={{ alignSelf: 'stretch', marginTop: space.lg }}>
          {(v.operatingHours ?? [])
            .slice()
            .sort((a: any, b: any) => a.dayOfWeek - b.dayOfWeek)
            .map((h: any) => (
              <View
                key={h.dayOfWeek}
                style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}
              >
                <T variant="label" tone="muted">
                  {DAYS[h.dayOfWeek]}
                </T>
                <T variant="label" weight="semibold" tone={h.isClosed ? 'error' : 'ink'}>
                  {h.isClosed ? 'Closed' : `${h.openTime} – ${h.closeTime}`}
                </T>
              </View>
            ))}
        </View>
        <PillButton label="Done" size="md" onPress={() => setShowHours(false)} style={{ alignSelf: 'stretch', marginTop: space.lg }} />
      </PopupCard>

      {/* Active promos */}
      <PopupCard visible={showPromos} onClose={() => setShowPromos(false)}>
        <IconChip icon="tag" size={56} />
        <T variant="heading" style={{ marginTop: space.md }}>
          Promos
        </T>
        <View style={{ alignSelf: 'stretch', marginTop: space.lg, gap: space.md }}>
          {promos.map((p: any) => (
            <View key={p.code} style={{ borderWidth: 1, borderColor: color.border.subtle, borderRadius: radius.md, padding: space.md }}>
              <T variant="body" weight="bold" tone="brand">
                {p.code}
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {p.description}
              </T>
              {p.minOrderAmount ? (
                <T variant="caption" tone="faint" style={{ marginTop: 2 }}>
                  Min order {money(p.minOrderAmount)}
                </T>
              ) : null}
            </View>
          ))}
        </View>
        <T variant="caption" tone="muted" center style={{ marginTop: space.md }}>
          Enter the code at checkout.
        </T>
        <PillButton label="Got it" size="md" onPress={() => setShowPromos(false)} style={{ alignSelf: 'stretch', marginTop: space.md }} />
      </PopupCard>
    </View>
  );
}
