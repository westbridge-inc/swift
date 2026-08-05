/** @jsxImportSource react */
import React, { useMemo, useState } from 'react';
import { Dimensions, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { useAddToCart, useItemSlots, useVendor } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { useBookingStore, type ServiceVisitMode } from '../../../stores/bookingStore';
import { DARK_BLURHASH, itemImage } from '../../../lib/images';
import { money } from '../../../lib/money';
import {
  Chip,
  CircleChip,
  ErrorState,
  IconChip,
  LoadingBlock,
  Money,
  PillButton,
  PopupCard,
  QtyStepper,
  SectionHeader,
  T,
} from '../../../kit';

const SCREEN_W = Dimensions.get('window').width;
const GUTTER = space['2xl'];

type Selected = Record<string, string | string[]>;

function defaultSelections(groups: any[]): Selected {
  const out: Selected = {};
  for (const g of groups ?? []) {
    const defaults = (g.options ?? []).filter((o: any) => o.isDefault).map((o: any) => o.id);
    if (g.maxSelect === 1) {
      if (defaults[0]) out[g.id] = defaults[0];
    } else if (defaults.length) {
      out[g.id] = defaults;
    }
  }
  return out;
}

// Kit Menu Detail V1 (21–24): hero + floating chips, sheet w/ name/price,
// tinted info bar, description, modifiers (Swift option groups — the kit has
// none, composed in kit chip language), sticky stepper + Add to cart, success
// popup. Out-of-stock (23): disabled dark CTA.
export function MenuItemScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { vendorId, itemId } = route.params ?? {};
  const { isAuthenticated, promptLogin } = useAuthStore();

  const vendor = useVendor<any>(vendorId);
  const addToCart = useAddToCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  // Appointment listings book a moment, not a quantity (kit chips reused as
  // day + time pickers). Dates run on the UTC calendar to mirror the API.
  const [dayOffset, setDayOffset] = useState(0);
  const [slot, setSlot] = useState<string | null>(null);
  const [visitMode, setVisitMode] = useState<ServiceVisitMode>('AT_BUSINESS');
  const setAppointment = useBookingStore((st) => st.setAppointment);

  const item = useMemo(
    () => vendor.data?.categories?.flatMap((c: any) => c.items ?? []).find((i: any) => i.id === itemId),
    [vendor.data, itemId],
  );
  const groups: any[] = item?.optionGroups ?? [];
  const [selected, setSelected] = useState<Selected>(() => defaultSelections(groups));

  const isBooking = item?.fulfillment === 'APPOINTMENT';
  // Dates run on the UTC calendar to mirror the API's slot math exactly.
  const selectedDate = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset))
      .toISOString()
      .slice(0, 10);
  }, [dayOffset]);
  const slotsQ = useItemSlots<any>(isBooking ? itemId : '', selectedDate);
  const serviceMode: 'AT_BUSINESS' | 'MOBILE' | 'BOTH' = slotsQ.data?.serviceMode ?? 'AT_BUSINESS';
  const bookableWeekdays: number[] | undefined = slotsQ.data?.bookableWeekdays;
  const daySlots: string[] = slotsQ.data?.slots ?? [];

  // Re-seed defaults when the item arrives after a cold load.
  const seededFor = React.useRef<string | null>(item ? itemId : null);
  React.useEffect(() => {
    if (item && seededFor.current !== itemId) {
      seededFor.current = itemId;
      setSelected(defaultSelections(item.optionGroups ?? []));
    }
  }, [item, itemId]);

  if (vendor.isLoading) return <LoadingBlock style={{ backgroundColor: color.surface.subtle }} />;
  if (vendor.isError || !item) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        <ErrorState
          onRetry={() => vendor.refetch()}
          message={!item && !vendor.isError ? 'This item is no longer on the menu.' : undefined}
        />
      </View>
    );
  }

  const outOfStock = item.stockQuantity === 0;
  const basePrice = Number(item.customerPrice ?? item.basePrice) || 0;

  const optionsPrice = groups.reduce((sum, g) => {
    const sel = selected[g.id];
    const ids = Array.isArray(sel) ? sel : sel ? [sel] : [];
    return sum + ids.reduce((s, id) => s + (Number(g.options?.find((o: any) => o.id === id)?.additionalPrice) || 0), 0);
  }, 0);
  const total = (basePrice + optionsPrice) * qty;

  const requiredUnmet = groups.some((g) => {
    if (!g.isRequired) return false;
    const sel = selected[g.id];
    const count = Array.isArray(sel) ? sel.length : sel ? 1 : 0;
    return count < Math.max(1, g.minSelect ?? 1);
  });

  const toggleOption = (g: any, optionId: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (g.maxSelect === 1) {
        next[g.id] = prev[g.id] === optionId && !g.isRequired ? [] : optionId;
        if (Array.isArray(next[g.id]) && (next[g.id] as string[]).length === 0) delete next[g.id];
        return next;
      }
      const cur = Array.isArray(prev[g.id]) ? [...(prev[g.id] as string[])] : [];
      const at = cur.indexOf(optionId);
      if (at >= 0) cur.splice(at, 1);
      else if (!g.maxSelect || cur.length < g.maxSelect) cur.push(optionId);
      if (cur.length) next[g.id] = cur;
      else delete next[g.id];
      return next;
    });
  };

  const onAdd = () => {
    if (!isAuthenticated) {
      promptLogin();
      return;
    }
    addToCart.mutate(
      { vendorId, itemId, quantity: isBooking ? 1 : qty, selectedOptions: Object.keys(selected).length ? selected : undefined },
      {
        onSuccess: () => {
          if (isBooking && slot) {
            setAppointment(itemId, { slotStart: slot, ...(serviceMode === 'BOTH' ? { mode: visitMode } : {}) });
          }
          setAdded(true);
        },
      },
    );
  };

  const addErr = addToCart.isError
    ? ((addToCart.error as any)?.response?.data?.error?.message ?? 'Could not add this. Try again.')
    : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 140 }}>
        {/* Hero + floating header */}
        <View>
          <Image
            source={{ uri: itemImage(item) }}
            placeholder={{ blurhash: DARK_BLURHASH }}
            transition={200}
            style={{ width: SCREEN_W, height: 340 }}
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
              justifyContent: 'space-between',
            }}
          >
            <CircleChip icon="chevron-left" onPress={() => navigation.goBack()} />
          </View>
        </View>

        {/* Sheet */}
        <View
          style={{
            marginTop: -radius.xl,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            backgroundColor: color.surface.subtle,
            paddingTop: space['2xl'],
            paddingHorizontal: GUTTER,
          }}
        >
          <T variant="title">{item.name}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm }}>
            <Money amount={basePrice} size="l" tone="brand" />
            {outOfStock ? (
              <View
                style={{
                  paddingHorizontal: space.md,
                  paddingVertical: 4,
                  borderRadius: 9999,
                  backgroundColor: color.soft.warning,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <Feather name="slash" size={12} color={color.warning} />
                <T variant="caption" weight="semibold" tone="warning">
                  Out of stock
                </T>
              </View>
            ) : null}
          </View>

          {/* Tinted info bar — real vendor facts */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: color.brand[50],
              borderRadius: radius.md,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              marginTop: space.lg,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Feather name="clock" size={14} color={color.brand[600]} />
              <T variant="label" tone="deep">
                {isBooking ? `${slotsQ.data?.durationMinutes ?? 30} min service` : `${vendor.data?.estimatedPrepTime ?? 30} min prep`}
              </T>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Feather name="star" size={14} color={color.star} />
              <T variant="label" tone="deep">
                {vendor.data?.displayRating != null ? Number(vendor.data.displayRating).toFixed(1) : 'New'}
              </T>
            </View>
            {item.isPopular ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Feather name="trending-up" size={14} color={color.brand[600]} />
                <T variant="label" tone="deep">
                  Popular
                </T>
              </View>
            ) : null}
          </View>

          {item.description ? (
            <>
              <SectionHeader title="Description" style={{ marginTop: space['2xl'] }} />
              <T variant="body" tone="muted" style={{ marginTop: space.md }}>
                {item.description}
              </T>
            </>
          ) : null}

          {/* Modifiers — Swift option groups in kit chip language */}
          {groups.map((g) => {
            const sel = selected[g.id];
            const selIds = Array.isArray(sel) ? sel : sel ? [sel] : [];
            return (
              <View key={g.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space['2xl'] }}>
                  <T variant="heading" style={{ flex: 1 }}>
                    {g.name}
                  </T>
                  <T variant="caption" tone={g.isRequired ? 'warning' : 'faint'}>
                    {g.isRequired ? 'Required' : 'Optional'}
                    {g.maxSelect > 1 ? ` · up to ${g.maxSelect}` : ''}
                  </T>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.md }}>
                  {(g.options ?? []).map((o: any) => {
                    const on = selIds.includes(o.id);
                    const price = Number(o.additionalPrice) || 0;
                    return (
                      <Chip
                        key={o.id}
                        label={`${o.name}${price ? ` +${money(price)}` : ''}`}
                        selected={on}
                        onPress={() => toggleOption(g, o.id)}
                        style={{ height: 42, paddingHorizontal: space.lg }}
                      />
                    );
                  })}
                </View>
              </View>
            );
          })}

          {isBooking ? (
            <>
              {/* Where it happens — the business's setting; BOTH lets you pick */}
              <SectionHeader title="Where" style={{ marginTop: space['2xl'] }} />
              {serviceMode === 'BOTH' ? (
                <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                  <Chip
                    label="You go to them"
                    selected={visitMode === 'AT_BUSINESS'}
                    onPress={() => setVisitMode('AT_BUSINESS')}
                    style={{ height: 42, paddingHorizontal: space.lg }}
                  />
                  <Chip
                    label="They come to you"
                    selected={visitMode === 'MOBILE'}
                    onPress={() => setVisitMode('MOBILE')}
                    style={{ height: 42, paddingHorizontal: space.lg }}
                  />
                </View>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: space.md }}>
                  <Feather name={serviceMode === 'MOBILE' ? 'navigation' : 'map-pin'} size={14} color={color.brand[600]} />
                  <T variant="label" tone="muted" style={{ flex: 1 }}>
                    {serviceMode === 'MOBILE'
                      ? `They come to your address${slotsQ.data?.serviceRadiusKm ? ` (within ${slotsQ.data.serviceRadiusKm} km)` : ''}`
                      : `At ${vendor.data?.name ?? 'their place'}${vendor.data?.addressLine1 ? ` — ${vendor.data.addressLine1}` : ''}`}
                  </T>
                </View>
              )}
              {serviceMode === 'BOTH' && visitMode === 'MOBILE' ? (
                <T variant="caption" tone="faint" style={{ marginTop: 6 }}>
                  They travel to your saved address{slotsQ.data?.serviceRadiusKm ? ` (within ${slotsQ.data.serviceRadiusKm} km)` : ''}.
                </T>
              ) : null}

              {/* When — day chips + real availability from the booking engine */}
              <SectionHeader title="Pick a time" style={{ marginTop: space['2xl']}} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.md, flexGrow: 0 }} contentContainerStyle={{ gap: space.md }}>
                {Array.from({ length: 7 }, (_, i) => {
                  const now = new Date();
                  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
                  const wd = d.getUTCDay();
                  const closed = bookableWeekdays ? !bookableWeekdays.includes(wd) : false;
                  const label =
                    i === 0
                      ? 'Today'
                      : i === 1
                        ? 'Tomorrow'
                        : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]} ${d.getUTCDate()}`;
                  return (
                    <Chip
                      key={i}
                      label={closed ? `${label} · closed` : label}
                      selected={dayOffset === i}
                      onPress={() => {
                        if (closed) return;
                        setDayOffset(i);
                        setSlot(null);
                      }}
                      style={{ height: 40, paddingHorizontal: space.lg, opacity: closed ? 0.45 : 1 }}
                    />
                  );
                })}
              </ScrollView>
              {slotsQ.isLoading ? (
                <T variant="label" tone="muted" style={{ marginTop: space.md }}>
                  Checking times…
                </T>
              ) : daySlots.length === 0 ? (
                <T variant="label" tone="muted" style={{ marginTop: space.md }}>
                  No times left this day — try another.
                </T>
              ) : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.md }}>
                  {daySlots.map((iso) => (
                    <Chip
                      key={iso}
                      label={new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}
                      selected={slot === iso}
                      onPress={() => setSlot(iso)}
                      style={{ height: 42, paddingHorizontal: space.lg }}
                    />
                  ))}
                </View>
              )}
              {slotsQ.data?.durationMinutes ? (
                <T variant="caption" tone="faint" style={{ marginTop: space.sm }}>
                  Each appointment runs about {slotsQ.data.durationMinutes} minutes.
                </T>
              ) : null}
            </>
          ) : null}

          {addErr ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.lg }}>
              <Feather name="alert-circle" size={14} color={color.error} />
              <T variant="label" tone="error">
                {addErr}
              </T>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* Sticky action bar — stepper + Add to cart (kit 21) */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingHorizontal: GUTTER,
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space.lg,
          backgroundColor: color.surface.base,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          boxShadow: '0px -4px 12px rgba(33,26,26,0.08)',
          elevation: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.lg,
        }}
      >
        {isBooking ? null : (
          <QtyStepper value={qty} onDec={() => setQty((q) => Math.max(1, q - 1))} onInc={() => setQty((q) => q + 1)} min={1} />
        )}
        <PillButton
          label={
            outOfStock
              ? 'Out of stock'
              : isBooking
                ? slot
                  ? `Book ${new Date(slot).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} · ${money(total)}`
                  : 'Pick a time'
                : `Add to cart · ${money(total)}`
          }
          icon={isBooking ? 'calendar' : 'shopping-cart'}
          variant={outOfStock ? 'dark' : 'primary'}
          disabled={outOfStock || requiredUnmet || (isBooking && !slot)}
          loading={addToCart.isPending}
          onPress={onAdd}
          style={{ flex: 1 }}
        />
      </View>

      {/* Success popup (kit 24) */}
      <PopupCard visible={added} onClose={() => setAdded(false)}>
        <IconChip icon="shopping-cart" size={64} />
        <T variant="heading" center style={{ marginTop: space.md }}>
          {isBooking ? 'Booking added — confirm at checkout' : 'Added to your cart!'}
        </T>
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton
            label="View cart"
            size="md"
            onPress={() => {
              setAdded(false);
              navigation.navigate('Tabs', { screen: 'Cart' });
            }}
          />
          <PillButton label="Keep browsing" variant="soft" size="md" onPress={() => setAdded(false)} />
        </View>
      </PopupCard>
    </View>
  );
}
