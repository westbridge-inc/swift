import { memo, useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import type { FlashListRef, ViewToken } from '@shopify/flash-list';
import { color } from '@swift/ui';
import { Text, Heading, Skeleton, Button, List, Image, PressableScale, EmptyState, Scrim, elevation, toast } from '../../../components/ui';
import { useVendor, useCart, useToggleFavorite } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import { money } from '../../../lib/money';
import { fallbackImage, kindForVendor, vendorImage, type ImageKind } from '../../../lib/images';

type Row = { type: 'header'; key: string; name: string } | { type: 'item'; key: string; item: any };
type Section = { name: string; row: number };

const HERO_H = 264;
const SHEET_R = 24;
const SHADOW = { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 } as const;

function BackButton({ onPress }: { onPress?: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <PressableScale
      onPress={onPress}
      hitSlop={10}
      style={[{ position: 'absolute', top: insets.top + 8, left: 16, zIndex: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base }, SHADOW]}
    >
      <Feather name="chevron-left" size={24} color={color.text.primary} />
    </PressableScale>
  );
}

function FavoriteButton({ vendorId, initial }: { vendorId: string; initial?: boolean }) {
  const insets = useSafeAreaInsets();
  const [fav, setFav] = useState(!!initial);
  const toggle = useToggleFavorite();
  return (
    <PressableScale
      onPress={() => {
        if (!useAuthStore.getState().isAuthenticated) { useAuthStore.getState().promptLogin(); return; }
        setFav((f) => !f);
        toggle.mutate({ vendorId, isFavorite: fav });
        if (fav) toast.show('Removed from favorites');
        else toast.success('Saved to favorites');
      }}
      hitSlop={10}
      style={[{ position: 'absolute', top: insets.top + 8, right: 16, zIndex: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base }, SHADOW]}
    >
      <MaterialCommunityIcons name={fav ? 'heart' : 'heart-outline'} size={20} color={fav ? color.brand[500] : color.text.primary} />
    </PressableScale>
  );
}

const MenuItemRow = memo(function MenuItemRow({ item, onOpen, kind }: { item: any; onOpen: () => void; kind?: ImageKind }) {
  const unavailable = item.isAvailable === false;
  const customizable = (item.optionGroups?.length ?? 0) > 0;
  return (
    <PressableScale onPress={onOpen} disabled={unavailable}>
      <View className="mx-lg flex-row items-start border-b border-border-subtle py-md" style={unavailable ? { opacity: 0.55 } : undefined}>
        <View className="flex-1 pr-md">
          <Text className="text-base font-semibold text-text-primary">{item.name}</Text>
          {item.description ? (
            <Text className="mt-xs text-sm text-text-secondary" numberOfLines={2}>{item.description}</Text>
          ) : null}
          <Text className="mt-sm text-sm font-extrabold" style={{ color: color.brand[600] }}>{money(item.customerPrice ?? item.basePrice)}</Text>
          {customizable && !unavailable ? (
            <Text className="mt-xs text-xs font-medium text-text-muted">Customizable</Text>
          ) : null}
        </View>
        <View style={{ width: 96, height: 96 }}>
          <Image source={{ uri: item.imageUrl || fallbackImage(item.id, kind) }} style={{ width: 96, height: 96, borderRadius: 16 }} />
          <View
            pointerEvents="none"
            style={[{ position: 'absolute', bottom: 6, right: 6, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base }, SHADOW]}
          >
            <Feather name={unavailable ? 'slash' : 'plus'} size={16} color={unavailable ? color.text.muted : color.text.primary} />
          </View>
        </View>
      </View>
    </PressableScale>
  );
});

function StatusPill({ closed }: { closed: boolean }) {
  if (closed) {
    return (
      <View className="self-start rounded-full bg-surface-subtle px-2.5 py-1">
        <Text className="text-xs font-bold text-text-secondary">Closed now</Text>
      </View>
    );
  }
  return (
    <View className="flex-row items-center self-start rounded-full bg-success/10 px-2.5 py-1">
      <View className="mr-1 h-2 w-2 rounded-full" style={{ backgroundColor: color.success }} />
      <Text className="text-xs font-bold text-success">Open now</Text>
    </View>
  );
}

// Horizontal section rail — jump to a menu section; the active chip follows the
// scroll position. Ink fill for the active state: the rail is navigation, and
// the red budget on this screen belongs to prices and live promos.
function CategoryRail({
  sections,
  active,
  onJump,
  scrollRef,
  onChipLayout,
}: {
  sections: Section[];
  active: number;
  onJump: (idx: number) => void;
  scrollRef?: Ref<ScrollView>;
  onChipLayout?: (idx: number, x: number) => void;
}) {
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center' }}
      style={{ flexGrow: 0 }}
    >
      {sections.map((s, i) => {
        const on = i === active;
        return (
          <PressableScale
            key={s.row}
            onPress={() => onJump(i)}
            onLayout={(e) => onChipLayout?.(i, e.nativeEvent.layout.x)}
          >
            <View className="rounded-full px-4 py-2" style={{ backgroundColor: on ? color.text.primary : color.surface.subtle }}>
              <Text className={on ? 'text-sm font-bold text-white' : 'text-sm font-semibold text-text-secondary'}>{s.name}</Text>
            </View>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}

// Immersive hero — the photo bleeds behind the status bar, then the content
// sheet tucks over its bottom edge (the same rounded-seam move as the Home
// canopy). One tappable rating row is the reviews entry — never state the
// rating twice.
function VendorHeader({ vendor, onReviews }: { vendor: any; onReviews?: () => void }) {
  const rating = vendor.averageRating && vendor.averageRating > 0 ? Number(vendor.averageRating).toFixed(1) : 'New';
  // Mirror the checkout gate (isCurrentlyOpen && acceptingOrders) so a vendor
  // that's open-by-hours but paused still reads as "Closed now".
  const closed = vendor.isCurrentlyOpen === false || vendor.acceptingOrders === false;
  return (
    <View className="bg-surface-base">
      <View>
        <Image source={{ uri: vendorImage(vendor) }} style={{ width: '100%', height: HERO_H }} />
        <Scrim anchor="top" height={110} to="rgba(0,0,0,0.40)" />
      </View>
      <View
        style={{
          marginTop: -SHEET_R,
          borderTopLeftRadius: SHEET_R,
          borderTopRightRadius: SHEET_R,
          backgroundColor: color.surface.base,
          paddingTop: 18,
          paddingHorizontal: 16,
        }}
      >
        <StatusPill closed={closed} />
        <Heading size="3xl" className="mt-sm text-text-primary">{vendor.name}</Heading>
        {vendor.description ? <Text className="mt-xs text-sm text-text-secondary" numberOfLines={2}>{vendor.description}</Text> : null}
        <PressableScale onPress={onReviews}>
          <View className="mt-sm flex-row items-center">
            <MaterialCommunityIcons name="star" size={15} color={color.brand[500]} />
            <Text className="ml-1 text-sm font-bold text-text-primary">{rating}</Text>
            <Text className="ml-1 text-sm text-text-muted">{vendor.totalRatings ? `(${vendor.totalRatings} ratings)` : '(no reviews yet)'}</Text>
            <Text className="mx-2 text-text-muted">·</Text>
            <Feather name="clock" size={14} color={color.text.secondary} />
            <Text className="ml-1 text-sm text-text-secondary">{vendor.estimatedPrepTime ?? 25} min</Text>
            {vendor.distanceKm != null ? (
              <>
                <Text className="mx-2 text-text-muted">·</Text>
                <Text className="text-sm text-text-secondary">{vendor.distanceKm} km</Text>
              </>
            ) : null}
            <Feather name="chevron-right" size={16} color={color.text.muted} style={{ marginLeft: 4 }} />
          </View>
        </PressableScale>
        {/* The model — these are the real prices */}
        <View className="mt-md flex-row items-center rounded-2xl bg-surface-subtle px-md py-sm">
          <MaterialCommunityIcons name="cash-check" size={16} color={color.success} />
          <Text className="ml-sm flex-1 text-xs font-semibold text-text-secondary">
            The vendor’s real prices — no fees, no markup. Pay cash.
            {vendor.minOrderAmount ? ` Minimum order ${money(vendor.minOrderAmount)}.` : ''}
          </Text>
        </View>
        {/* Live promotions (§4.2) — use the code at checkout */}
        {(vendor.promos ?? []).map((p: any) => (
          <View key={p.code} className="mt-sm flex-row items-center rounded-2xl px-md py-sm" style={{ backgroundColor: color.brand[50] }}>
            <MaterialCommunityIcons name="tag" size={16} color={color.brand[600]} />
            <View className="ml-sm flex-1">
              <Text className="text-sm font-semibold" style={{ color: color.brand[700] }}>
                {p.code} — {p.discountType === 'PERCENTAGE' ? `${p.discountValue}% off` : `${money(p.discountValue)} off`}
                {p.minOrderAmount ? ` over ${money(p.minOrderAmount)}` : ''}
              </Text>
              <Text className="text-xs text-text-secondary" numberOfLines={1}>{p.description} · enter it at checkout</Text>
            </View>
          </View>
        ))}
        <View style={{ height: 6 }} />
      </View>
    </View>
  );
}

export function VendorDetailScreen({ navigation, route }: any) {
  const id: string = route?.params?.id ?? '';
  const insets = useSafeAreaInsets();
  const { data: vendor, isLoading, isError, refetch } = useVendor<any>(id);
  const { data: cart } = useCart<any>();

  const listRef = useRef<FlashListRef<Row>>(null);
  const pinnedRailRef = useRef<ScrollView>(null);
  const chipX = useRef<Record<number, number>>({});
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState(false);

  const { rows, sections } = useMemo(() => {
    const rows: Row[] = [];
    const sections: Section[] = [];
    for (const cat of vendor?.categories ?? []) {
      sections.push({ name: cat.name, row: rows.length });
      rows.push({ type: 'header', key: `h_${cat.id}`, name: cat.name });
      for (const it of cat.items ?? []) rows.push({ type: 'item', key: String(it.id), item: it });
    }
    return { rows, sections };
  }, [vendor]);

  // The pinned bar covers insets.top + name row + rail; jumps land below it.
  const pinnedBarH = insets.top + 42 + (sections.length > 1 ? 44 : 0);

  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const pinnedBarHRef = useRef(pinnedBarH);
  pinnedBarHRef.current = pinnedBarH;

  const jumpTo = useCallback((idx: number) => {
    const s = sectionsRef.current[idx];
    if (!s) return;
    setActive(idx);
    listRef.current?.scrollToIndex({ index: s.row, animated: true, viewOffset: pinnedBarHRef.current + 6 });
  }, []);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    setPinned(y > HERO_H - SHEET_R - 8);
  }, []);

  // Stable identity — FlatList/FlashList reject a changing onViewableItemsChanged.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1, minimumViewTime: 40 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<Row>[] }) => {
    const first = viewableItems.find((v) => v.isViewable)?.index;
    if (first == null) return;
    const secs = sectionsRef.current;
    let idx = 0;
    for (let i = 0; i < secs.length; i++) if (secs[i]!.row <= first) idx = i;
    setActive((prev) => (prev === idx ? prev : idx));
  }).current;

  // Keep the active chip in view on the pinned rail.
  useEffect(() => {
    if (!pinned) return;
    const x = chipX.current[active];
    if (x != null) pinnedRailRef.current?.scrollTo({ x: Math.max(0, x - 16), animated: true });
  }, [active, pinned]);

  const onChipLayout = useCallback((idx: number, x: number) => { chipX.current[idx] = x; }, []);

  const cartCount = cart?.itemCount ?? 0;
  const cartSubtotal = cart?.subtotalCustomer ?? 0;

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="p-lg">
          <Skeleton className="mb-md h-52 w-full rounded-2xl" />
          <Skeleton className="mb-sm h-6 w-2/3" />
          <Skeleton className="mb-lg h-4 w-1/2" />
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="mb-md h-20 w-full rounded-xl" />)}
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !vendor) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <BackButton onPress={() => navigation?.goBack?.()} />
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon="alert-circle-outline"
            title="Couldn’t load this place"
            body="Something went wrong on our end."
            actionLabel="Retry"
            onAction={() => refetch()}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1 }} className="bg-surface-base">
      <List
        ref={listRef}
        data={rows}
        keyExtractor={(r: Row) => r.key}
        getItemType={(r: Row) => r.type}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        ListHeaderComponent={
          <View>
            <VendorHeader vendor={vendor} onReviews={() => navigation?.navigate?.('VendorReviews', { id, vendorName: vendor.name, averageRating: vendor.averageRating })} />
            {sections.length > 1 ? (
              <View className="border-b border-border-subtle bg-surface-base pb-2">
                <CategoryRail sections={sections} active={active} onJump={jumpTo} onChipLayout={onChipLayout} />
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item: row }: { item: Row }) =>
          row.type === 'header' ? (
            <Heading size="lg" className="px-lg pb-sm pt-lg">{row.name}</Heading>
          ) : (
            <MenuItemRow
              item={row.item}
              kind={kindForVendor(vendor)}
              onOpen={() => navigation?.navigate?.('ItemDetail', { vendorId: id, item: row.item, vendorKind: kindForVendor(vendor) })}
            />
          )
        }
        ListEmptyComponent={<EmptyState icon="silverware-fork-knife" title="No items yet" body="This place hasn’t added its menu — check back soon." />}
        contentContainerStyle={{ paddingBottom: 140 + insets.bottom }}
      />

      {/* Pinned bar — appears once the hero scrolls away (name + section rail). */}
      {pinned ? (
        <View
          style={[
            { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5, backgroundColor: color.surface.base, paddingTop: insets.top },
            elevation.card,
          ]}
        >
          <View style={{ height: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 64 }}>
            <Text className="font-display text-base font-bold text-text-primary" numberOfLines={1}>{vendor.name}</Text>
          </View>
          {sections.length > 1 ? (
            <View style={{ height: 44, justifyContent: 'center' }}>
              <CategoryRail sections={sections} active={active} onJump={jumpTo} scrollRef={pinnedRailRef} onChipLayout={onChipLayout} />
            </View>
          ) : null}
          <View className="h-px bg-border-subtle" />
        </View>
      ) : null}

      <BackButton onPress={() => navigation?.goBack?.()} />
      <FavoriteButton vendorId={id} initial={vendor.isFavorite} />

      {cartCount > 0 ? (
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 12 }}>
          <Button onPress={() => navigation?.navigate?.('Cart')} style={elevation.floating}>
            <View className="w-full flex-row items-center justify-between">
              <Text className="font-body font-semibold text-white">
                View cart · {cartCount} {cartCount === 1 ? 'item' : 'items'}
              </Text>
              <Text className="font-body font-semibold text-white">{money(cartSubtotal)}</Text>
            </View>
          </Button>
        </View>
      ) : null}
    </View>
  );
}
