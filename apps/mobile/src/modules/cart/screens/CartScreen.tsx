/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { customerApi } from '../../../services/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useCart,
  useClearCart,
  usePlaceOrder,
  useRemoveCartItem,
  useSetCartTip,
  useUpdateCartItem,
} from '../../../hooks/customer';
import { maybePrimeNotifications } from '../../../services/notification-priming';
import { useAuthStore } from '../../../stores/authStore';
import { useBookingStore } from '../../../stores/bookingStore';
import { useLocationStore } from '../../../stores/locationStore';
import { DARK_BLURHASH, itemImage } from '../../../lib/images';
import { money } from '../../../lib/money';
import { openPayLink } from '../../../lib/payLink';
import { haptic } from '../../../lib/haptics';
import {
  AddMorph,
  Card,
  Chip,
  CircleChip,
  EmptyState,
  ErrorState,
  IconChip,
  InfoRow,
  LabeledInput,
  LoadingBlock,
  Money,
  PillButton,
  PopupCard,
  Screen,
  T,
} from '../../../kit';
import { BrandSwitch } from '../../../kit/controls';

const GUTTER = space['2xl'];
const TIP_PRESETS = [0, 200, 500, 1000];

// Kit My Cart (29–34). The kit folds checkout into the cart: delivery location,
// promo apply, line items, summary, Order Now → success popup → tracking.
// V1 is cash-only, so payment is a stated fact, not a choice.
export function CartScreen() {
  const navigation = useNavigation<any>();
  const qc = useQueryClient();
  const { isAuthenticated, promptLogin } = useAuthStore();
  const { latitude, longitude } = useLocationStore();

  const cart = useCart<any>(latitude ?? undefined, longitude ?? undefined);
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveCartItem();
  const clearCart = useClearCart();
  const setTip = useSetCartTip();
  const placeOrder = usePlaceOrder<any>();

  const [promo, setPromo] = useState('');
  const [promoMsg, setPromoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [promoPopup, setPromoPopup] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [express, setExpress] = useState(false);
  const [payMethod, setPayMethod] = useState<'CASH' | 'MMG'>('CASH');
  // Pickup spec 2.1: the FIRST decision — it reshapes everything below.
  const [fulfillment, setFulfillment] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY');
  const [placedPickup, setPlacedPickup] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [placedOrderId, setPlacedOrderId] = useState<string | null>(null);
  // LIFECYCLE_V2: while held, the store has NOT been told yet — say so honestly.
  const [placedHeld, setPlacedHeld] = useState(false);
  // The cart empties after placement — remember it was a booking for the popup.
  const [placedAppt, setPlacedAppt] = useState(false);
  const appointments = useBookingStore((s) => s.appointments);
  const clearAppointments = useBookingStore((s) => s.clear);

  const applyPromo = useMutation({
    mutationFn: (code: string) => customerApi.validatePromo(code),
    // Own inline feedback (promoMsg) — opt out of the global error toast.
    meta: { silent: true },
    onSuccess: (res) => {
      const d = res.data?.data;
      setPromoMsg({ ok: true, text: d?.description ?? 'Promo applied' });
      setPromoPopup(true);
      qc.invalidateQueries({ queryKey: ['customer', 'cart'] });
    },
    onError: (e: any) => {
      setPromoMsg({ ok: false, text: e?.response?.data?.error?.message ?? 'That code didn’t work' });
    },
  });

  if (!isAuthenticated) {
    return (
      <Screen>
        <View style={{ height: 56, alignItems: 'center', justifyContent: 'center' }}>
          <T variant="heading">Cart</T>
        </View>
        <EmptyState
          picto="groceries"
          title="Sign in to start a cart"
          body="Your basket lives on your account so it follows you between devices."
          actionLabel="Sign in"
          onAction={promptLogin}
        />
      </Screen>
    );
  }

  const c = cart.data; // null = empty cart
  const items: any[] = c?.items ?? [];

  // PU-05: the MMG row is an opt-in fact from the cart, not a default — and a
  // lingering MMG selection from a previous cart degrades safely to cash.
  const acceptsMmg = !!c?.vendor?.acceptsMmg;
  const effectivePay: 'CASH' | 'MMG' = acceptsMmg ? payMethod : 'CASH';

  // Appointment lines need their chosen slot (picked on the service screen)
  // before checkout — the API rejects slotless bookings with SLOT_REQUIRED.
  const bookingItems = items.filter((i) => i.fulfillment === 'APPOINTMENT');
  const unslotted = bookingItems.filter((i) => !appointments[i.itemId]);
  const apptPayload = bookingItems
    .filter((i) => appointments[i.itemId])
    .map((i) => ({ itemId: i.itemId, slotStart: appointments[i.itemId]!.slotStart, ...(appointments[i.itemId]!.mode ? { mode: appointments[i.itemId]!.mode } : {}) }));

  // A booking is not a delivery: no rider, no delivery fee, no address unless
  // the pro travels to you. The checkout reshapes itself around that.
  const apptOnly = items.length > 0 && bookingItems.length === items.length;
  // Bookings have no counter to collect from; pickup applies to goods carts.
  const pickup = !apptOnly && fulfillment === 'PICKUP';
  const choosePickup = () => {
    setFulfillment('PICKUP');
    setExpress(false); // express is a delivery speed
    // No rider on a pickup — clear any rider tip SERVER-side so totals stay
    // server-truth (the UI below hides the tip block while picked).
    if (Number(c?.tipAmount) > 0) setTip.mutate(0);
  };
  const homeVisit = apptOnly && apptPayload.some((a) => (a as { mode?: string }).mode === 'MOBILE');
  // PU-01 law (caught by the certification pass): a pickup order is collected
  // at the counter — it must NEVER demand a delivery address. Address is for
  // delivery carts and home-visit bookings only.
  const needsAddress = (!apptOnly && !pickup) || homeVisit;
  // Slot ISOs carry local wall-clock time on their UTC face (same convention
  // as the slot picker) — format in UTC or the time shifts by the device TZ.
  const fmtSlot = (iso: string) => {
    const d = new Date(iso);
    const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    return `${day}, ${time}`;
  };

  const onOrder = (extra?: Record<string, unknown>) => {
    const asPickup = pickup && !!c?.vendor?.id;
    placeOrder.mutate(
      {
        paymentMethod: effectivePay === 'MMG' ? 'MOBILE_MONEY' : 'CASH',
        ...(express && !pickup ? { express: true } : {}),
        ...(apptPayload.length ? { appointments: apptPayload } : {}),
        ...(instructions.trim() && !pickup ? { deliveryInstructions: instructions.trim() } : {}),
        ...(asPickup ? { fulfillmentSelections: { [c.vendor.id]: 'PICKUP' } } : {}),
        ...(extra ?? {}),
      },
      {
        onSuccess: (data: any) => {
          haptic.success();
          setPlacedPickup(asPickup || (extra as any)?.fulfillmentSelections != null);
          const first = data?.orders?.[0];
          setPlacedOrderId(first?.id ?? null);
          setPlacedHeld(!!(first?.holdExpiresAt && new Date(first.holdExpiresAt) > new Date()));
          setPlacedAppt(apptPayload.length > 0);
          if (apptPayload.length) clearAppointments();
          // First order = the first moment notifications are obviously useful
          // [first-open SO-5]; primes once, never at boot.
          maybePrimeNotifications('customer_order');
          // MMG: take the customer straight to the store's own MMG link, in-app.
          if (effectivePay === 'MMG') void openPayLink(first?.vendor?.mmgPayUrl);
        },
        onError: (err: any) => {
          // Store isn't set up for MMG → fall back to cash so they can proceed.
          if (err?.response?.data?.error?.code === 'MMG_NOT_AVAILABLE') setPayMethod('CASH');
        },
      },
    );
  };

  const orderErr = placeOrder.isError
    ? ((placeOrder.error as any)?.response?.data?.error?.message ?? 'Could not place the order. Try again.')
    : undefined;
  // Availability spec §2: zero riders online → the server refuses delivery
  // honestly; pickup is the same food without the wait for a rider.
  const noRiders = (placeOrder.error as any)?.response?.data?.error?.code === 'DELIVERY_NO_RIDERS';
  const retryAsPickup = () => {
    const vendorId = c?.vendor?.id;
    if (!vendorId) return;
    onOrder({ fulfillmentSelections: { [vendorId]: 'PICKUP' } });
  };

  return (
    <Screen>
      {/* Tab header: centered title + overflow (clear cart) */}
      <View
        style={{
          height: 56,
          paddingHorizontal: GUTTER,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ width: 44 }} />
        <T variant="heading">Cart</T>
        <CircleChip icon="more-horizontal" onPress={() => setMenuOpen(true)} />
      </View>

      {cart.isLoading ? (
        <LoadingBlock />
      ) : cart.isError ? (
        <ErrorState onRetry={() => cart.refetch()} />
      ) : !c || items.length === 0 ? (
        <EmptyState
          picto="groceries"
          title="Your cart is empty"
          body="Add something good — it lands here."
          actionLabel="Find food"
          onAction={() => navigation.navigate('Search')}
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Pickup spec 2.1 — the mode choice, first and unmissable. */}
          {!apptOnly && items.length > 0 ? (
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
              {(['DELIVERY', 'PICKUP'] as const).map((mode) => {
                const active = fulfillment === mode;
                return (
                  <Pressable key={mode} style={{ flex: 1 }} onPress={() => (mode === 'PICKUP' ? choosePickup() : setFulfillment('DELIVERY'))}>
                    <View
                      style={{
                        height: 44,
                        borderRadius: radius.full,
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexDirection: 'row',
                        gap: 6,
                        borderWidth: 1.5,
                        borderColor: active ? color.brand[500] : color.border.strong,
                        backgroundColor: active ? color.brand[500] : color.surface.base,
                      }}
                    >
                      <Feather name={mode === 'DELIVERY' ? 'navigation' : 'shopping-bag'} size={15} color={active ? color.white : color.text.muted} />
                      <T variant="label" weight="semibold" style={{ color: active ? color.white : color.text.primary }}>
                        {mode === 'DELIVERY' ? 'Delivery' : 'Pickup'}
                      </T>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {/* Delivery location — or the service address when the pro travels to
              you. An at-the-business booking has no address to collect at all.
              Pickup: the SHOP is the address — show where to collect. */}
          {pickup ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md }}>
              <Feather name="shopping-bag" size={14} color={color.text.muted} />
              <View style={{ flex: 1 }}>
                <T variant="label" tone="muted">Pick up from</T>
                <T variant="body" weight="semibold" style={{ marginTop: 2 }} numberOfLines={1}>
                  {c.vendor?.name ?? 'The store'}
                </T>
              </View>
            </View>
          ) : needsAddress ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm }}>
              <View style={{ flex: 1 }}>
                <T variant="label" tone="muted">
                  {apptOnly ? 'Service address' : 'Deliver to'}
                </T>
                <T variant="body" weight="semibold" style={{ marginTop: 2 }} numberOfLines={1}>
                  {c.deliveryAddress?.label ?? c.deliveryAddress?.addressLine1 ?? 'No address yet'}
                </T>
              </View>
              <PillButton
                label={c.deliveryAddress ? 'Change' : 'Add address'}
                variant="soft"
                size="sm"
                onPress={() => navigation.navigate('Addresses', { selectFor: 'cart' })}
              />
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm }}>
              <Feather name="map-pin" size={14} color={color.text.muted} />
              <T variant="label" tone="muted">
                At the business — show up at your booked time.
              </T>
            </View>
          )}

          {/* Promo code (kit 31–32) — server-applied via validate */}
          <View style={{ marginTop: space.xl }}>
            <LabeledInput
              icon="tag"
              placeholder="Promo code"
              autoCapitalize="characters"
              value={promo}
              onChangeText={(v) => {
                setPromo(v);
                setPromoMsg(null);
              }}
              right={
                <PillButton
                  label="Apply"
                  size="sm"
                  loading={applyPromo.isPending}
                  disabled={promo.trim().length < 3}
                  onPress={() => applyPromo.mutate(promo.trim())}
                />
              }
            />
            {promoMsg && !promoMsg.ok ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm, paddingLeft: space.lg }}>
                <Feather name="alert-circle" size={13} color={color.error} />
                <T variant="caption" tone="error">
                  {promoMsg.text}
                </T>
              </View>
            ) : null}
            {c.promoCode ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm, paddingLeft: space.lg }}>
                <Feather name="check-circle" size={13} color={color.success} />
                <T variant="caption" tone="success">
                  {c.promoCode.code} — {c.promoCode.description}
                </T>
              </View>
            ) : null}
          </View>

          {/* Line items */}
          <View style={{ gap: space.md, marginTop: space.xl }}>
            {items.map((it) => (
              <Card key={it.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md }}>
                <Image
                  source={{ uri: itemImage(it) }}
                  placeholder={{ blurhash: DARK_BLURHASH }}
                  transition={150}
                  style={{ width: 76, height: 76, borderRadius: radius.md }}
                  contentFit="cover"
                />
                <View style={{ flex: 1, gap: 4 }}>
                  <T variant="body" weight="semibold" numberOfLines={1}>
                    {it.name}
                  </T>
                  {it.selectedOptionNames?.length ? (
                    <T variant="caption" tone="muted" numberOfLines={1}>
                      {it.selectedOptionNames.join(', ')}
                    </T>
                  ) : null}
                  <View style={{ alignSelf: 'flex-start' }}>
                    <Money amount={it.customerPrice} tone="brand" />
                  </View>
                  {!it.isAvailable ? (
                    <T variant="caption" tone="error">
                      No longer available — remove to continue
                    </T>
                  ) : null}
                  <View style={{ marginTop: 4, alignSelf: 'flex-start' }}>
                    <AddMorph
                      qty={it.quantity}
                      busy={updateItem.isPending}
                      onAdd={() => updateItem.mutate({ id: it.id, quantity: it.quantity + 1 })}
                      onInc={() => updateItem.mutate({ id: it.id, quantity: it.quantity + 1 })}
                      onDec={() => it.quantity > 1 && updateItem.mutate({ id: it.id, quantity: it.quantity - 1 })}
                    />
                  </View>
                </View>
                <Pressable onPress={() => removeItem.mutate(it.id)} hitSlop={8}>
                  {({ pressed }) => (
                    <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                      <Feather name="trash-2" size={20} color={pressed ? color.brand[600] : color.error} />
                    </View>
                  )}
                </Pressable>
              </Card>
            ))}
          </View>

          {/* Tip the rider (real cart-level tip) — bookings have no rider,
              and neither does a pickup. */}
          {!apptOnly && !pickup ? (
            <>
              <T variant="heading" style={{ marginTop: space['2xl'] }}>
                Tip your rider
              </T>
              <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                {TIP_PRESETS.map((t) => (
                  <Chip
                    key={t}
                    label={t === 0 ? 'No tip' : money(t)}
                    selected={Number(c.tipAmount) === t}
                    onPress={() => setTip.mutate(t)}
                    style={{ height: 44, paddingHorizontal: space.lg }}
                  />
                ))}
              </View>
            </>
          ) : null}

          {/* Delivery instructions / notes for the pro — a pickup has neither. */}
          {!pickup ? (
            <View style={{ marginTop: space.xl }}>
              <LabeledInput
                icon="message-square"
                placeholder={apptOnly ? 'Notes for your appointment (optional)' : 'Delivery instructions (optional)'}
                value={instructions}
                onChangeText={setInstructions}
              />
            </View>
          ) : null}

          {/* Payment — cash, or pay the store directly on their own MMG */}
          <View style={{ marginTop: space.xl, gap: space.sm }}>
            <T variant="label" weight="semibold">
              Payment
            </T>
            {([
              {
                key: 'CASH' as const,
                icon: 'dollar-sign' as const,
                title: apptOnly ? 'Pay at your appointment' : pickup ? 'Pay at the counter' : 'Cash on delivery',
                sub: apptOnly
                  ? 'Cash, when the service is done.'
                  : pickup
                    ? 'Cash when you collect your order.'
                    : 'Pay the rider when your order arrives.',
              },
              // PU-05: the MMG row renders only where the vendor opted in.
              ...(acceptsMmg ? [{
                key: 'MMG' as const,
                icon: 'smartphone' as const,
                title: 'Pay with MMG',
                sub: 'Pay the business directly on their MMG — opens right in the app.',
              }] : []),
            ]).map((o) => {
              const active = effectivePay === o.key;
              return (
                <Pressable key={o.key} onPress={() => setPayMethod(o.key)}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.md,
                      padding: space.lg,
                      borderRadius: radius.md,
                      borderWidth: active ? 1.5 : 1,
                      borderColor: active ? color.brand[500] : color.border.strong,
                      backgroundColor: active ? color.brand[50] : color.surface.base,
                    }}
                  >
                    <Feather name={o.icon} size={18} color={active ? color.brand[600] : color.text.muted} />
                    <View style={{ flex: 1 }}>
                      <T variant="label" weight="semibold" tone={active ? 'deep' : 'ink'}>
                        {o.title}
                      </T>
                      <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                        {o.sub}
                      </T>
                    </View>
                    <Feather name={active ? 'check-circle' : 'circle'} size={18} color={active ? color.brand[500] : color.border.strong} />
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* Express delivery — priority dispatch; the premium goes to the rider */}
          {!pickup && c.deliveryFee > 0 ? (
            <Card style={{ marginTop: space.xl }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: space.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Feather name="zap" size={15} color={color.brand[500]} />
                    <T variant="body" weight="semibold">
                      Express delivery
                    </T>
                  </View>
                  <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    Jumps the dispatch queue · +{money(c.expressSurcharge)} — all of it goes to your rider.
                  </T>
                </View>
                <BrandSwitch value={express} onChange={() => setExpress((v) => !v)} />
              </View>
            </Card>
          ) : null}

          {/* Order summary */}
          <Card style={{ marginTop: space.xl }}>
            <T variant="heading">{apptOnly ? 'Booking summary' : 'Order summary'}</T>
            <View style={{ marginTop: space.md }}>
              <InfoRow label={`Items (${c.itemCount})`} value={money(c.subtotalCustomer)} />
              {!apptOnly && !pickup ? <InfoRow label="Delivery fee" value={c.deliveryFee === 0 ? 'Free' : money(c.deliveryFee)} /> : null}
              {pickup ? <InfoRow label="Pickup" value="No delivery fee" /> : null}
              {!pickup && express && c.deliveryFee > 0 ? <InfoRow label="Express" value={money(c.expressSurcharge)} /> : null}
              {c.discount > 0 ? <InfoRow label="Discount" value={`-${money(c.discount)}`} /> : null}
              {!apptOnly && !pickup && Number(c.tipAmount) > 0 ? <InfoRow label="Rider tip" value={money(c.tipAmount)} /> : null}
              <View style={{ height: 1, backgroundColor: color.border.subtle, marginVertical: space.sm }} />
              {/* Pickup preview = the same server numbers minus the delivery
                  leg; the server prices the real order at place time. */}
              <InfoRow
                label={pickup ? 'Total at the counter' : 'Total'}
                value={money(pickup ? c.totalAmount - c.deliveryFee - Number(c.tipAmount ?? 0) : express && c.deliveryFee > 0 ? c.expressTotal : c.totalAmount)}
                strong
              />
            </View>
            {apptOnly ? (
              <View style={{ marginTop: space.sm, gap: 4 }}>
                {bookingItems.map((i) =>
                  appointments[i.itemId] ? (
                    <View key={i.itemId} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Feather name="calendar" size={13} color={color.brand[500]} />
                      <T variant="caption" tone="muted">
                        {i.name} — {fmtSlot(appointments[i.itemId]!.slotStart)}
                        {appointments[i.itemId]!.mode === 'MOBILE' ? ' · at your address' : ''}
                      </T>
                    </View>
                  ) : null,
                )}
                <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                  Your time is confirmed when the business accepts the booking.
                </T>
              </View>
            ) : pickup ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                We&apos;ll tell you the moment it&apos;s ready — your pickup code shows on the order screen.
              </T>
            ) : c.estimatedTotalMin ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                Estimated arrival ~{c.estimatedTotalMin} min after the store confirms.
              </T>
            ) : null}
          </Card>

          {!c.meetsMinimum ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.md }}>
              <Feather name="alert-circle" size={14} color={color.warning} />
              <T variant="label" tone="warning">
                This store has a minimum order of {money(c.minimumOrderAmount)}.
              </T>
            </View>
          ) : null}
          {unslotted.length > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.md }}>
              <Feather name="calendar" size={14} color={color.warning} />
              <T variant="label" tone="warning">
                Pick a time for {unslotted[0].name} before ordering.
              </T>
            </View>
          ) : null}
          {orderErr ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.md }}>
              <Feather name="alert-circle" size={14} color={color.error} />
              <T variant="label" tone="error">
                {orderErr}
              </T>
            </View>
          ) : null}
          {noRiders ? (
            <PillButton
              label="Order for pickup instead — no delivery fee"
              variant="outline"
              size="md"
              style={{ marginTop: space.md }}
              loading={placeOrder.isPending}
              onPress={retryAsPickup}
            />
          ) : null}

          <PillButton
            label={apptOnly ? 'Book now' : pickup ? 'Place pickup order' : 'Place order'}
            // NEVER pass the handler bare: Pressable calls onPress(event) and the
            // cyclical press event would spread into onOrder's `extra` payload,
            // killing JSON serialization — no request ever left the phone
            // (certification catch: "cyclical structure in JSON object").
            onPress={() => onOrder()}
            loading={placeOrder.isPending}
            disabled={!c.meetsMinimum || c.unavailableItemIds?.length > 0 || (needsAddress && !c.deliveryAddress) || unslotted.length > 0}
            style={{ marginTop: space.xl }}
          />
          {needsAddress && !c.deliveryAddress ? (
            <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
              {homeVisit ? 'Add your address — the business travels to you.' : 'Add a delivery address to place the order.'}
            </T>
          ) : null}
        </ScrollView>
      )}

      {/* ••• menu — clear cart */}
      <PopupCard visible={menuOpen} onClose={() => setMenuOpen(false)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <T variant="heading" center style={{ marginTop: space.md }}>
          Clear your cart?
        </T>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          Every item will be removed.
        </T>
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton
            label="Clear cart"
            size="md"
            onPress={() => {
              clearCart.mutate();
              setMenuOpen(false);
            }}
          />
          <PillButton label="Keep it" variant="soft" size="md" onPress={() => setMenuOpen(false)} />
        </View>
      </PopupCard>

      {/* Voucher applied (kit 32) */}
      <PopupCard visible={promoPopup} onClose={() => setPromoPopup(false)}>
        <IconChip icon="tag" size={64} />
        <T variant="heading" center style={{ marginTop: space.md }}>
          Promo applied!
        </T>
        {promoMsg?.ok ? (
          <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
            {promoMsg.text}
          </T>
        ) : null}
        <PillButton label="Done" size="md" onPress={() => setPromoPopup(false)} style={{ alignSelf: 'stretch', marginTop: space.xl }} />
      </PopupCard>

      {/* Order placed (kit 34) */}
      <PopupCard
        visible={placeOrder.isSuccess}
        onClose={() => {
          const id = placedOrderId;
          placeOrder.reset();
          if (id) navigation.navigate('Delivery', { orderId: id });
        }}
      >
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: color.brand[500],
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name="check" size={30} color={color.white} />
        </View>
        <T variant="heading" center style={{ marginTop: space.md }}>
          {placedAppt ? 'Booking requested' : 'Your order is placed'}
        </T>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          {placedAppt
            ? 'Your time is confirmed when the business accepts — we will let you know.'
            : placedPickup
              ? 'We’ll tell you the moment it’s ready — show the pickup code on your order screen at the counter.'
              : placedHeld
                ? 'You have a few minutes to change your mind — cancelling is free until the store gets it.'
                : 'The store has been notified — pay cash on delivery.'}
        </T>
        <PillButton
          label={placedAppt ? 'View booking' : 'Track order'}
          size="md"
          onPress={() => {
            const id = placedOrderId;
            placeOrder.reset();
            if (id) navigation.navigate('Delivery', { orderId: id });
          }}
          style={{ alignSelf: 'stretch', marginTop: space.xl }}
        />
      </PopupCard>
    </Screen>
  );
}
