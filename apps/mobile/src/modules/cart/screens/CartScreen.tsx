/** @jsxImportSource react */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
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
import { itemPhoto } from '../../../lib/images';
import { money } from '../../../lib/money';
import { openMmgPaymentAction } from '../../../lib/payLink';
import { haptic } from '../../../lib/haptics';
import { toast } from '../../../components/ui/toast';
import {
  AddMorph,
  Card,
  Chip,
  GradientMasthead,
  Photo,
  CircleChip,
  DecorativeIcon,
  EmptyState,
  ErrorState,
  IconChip,
  InfoRow,
  LabeledInput,
  LoadingBlock,
  Money,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  T,
} from '../../../kit';
import { BrandSwitch } from '../../../kit/controls';
import type { MmgDirectPaymentAction } from '@swift/types';
import { CartPaymentOptions } from '../CartPaymentOptions';
import { checkoutTipAmount } from '../checkout-tip';
import {
  checkoutPaymentMethod,
  normalizeCartPaymentCapabilities,
  paymentActionForCheckout,
  placedOrderConfirmationCopy,
  reconcileCartPaymentSelection,
  selectCartPaymentMethod,
  type CartPaymentSelection,
} from '../cartPayment';

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
  const [selectedTip, setSelectedTip] = useState<number | null>(null);
  const [express, setExpress] = useState(false);
  const [paySelection, setPaySelection] = useState<CartPaymentSelection>({ method: 'CASH', scope: '' });
  // Pickup spec 2.1: the FIRST decision — it reshapes everything below.
  const [fulfillment, setFulfillment] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY');
  const [placedPickup, setPlacedPickup] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [placedOrderId, setPlacedOrderId] = useState<string | null>(null);
  // LIFECYCLE_V2: while held, the store has NOT been told yet — say so honestly.
  const [placedHeld, setPlacedHeld] = useState(false);
  const [placedSubmittedMethod, setPlacedSubmittedMethod] = useState<'CASH' | 'MOBILE_MONEY'>('CASH');
  const [placedPaymentAction, setPlacedPaymentAction] = useState<MmgDirectPaymentAction | null>(null);
  // The cart empties after placement — remember it was a booking for the popup.
  const [placedAppt, setPlacedAppt] = useState(false);
  const appointments = useBookingStore((s) => s.appointments);
  const clearAppointments = useBookingStore((s) => s.clear);
  const c = cart.data; // null = empty cart
  const paymentCapabilities = useMemo(
    () => normalizeCartPaymentCapabilities(c?.paymentCapabilities),
    [c?.paymentCapabilities],
  );
  const effectivePaySelection = reconcileCartPaymentSelection(paySelection, paymentCapabilities);

  // Tip intent belongs to one logical cart. Never reset it from tipAmount — a
  // late persistence response must not replace the customer's local choice.
  useEffect(() => {
    setSelectedTip(null);
  }, [c?.id]);

  // Persist the safe degradation. Merely deriving CASH would leave MMG hidden
  // in state, where it could silently revive when another capable cart loads.
  useEffect(() => {
    setPaySelection((current) => {
      const reconciled = reconcileCartPaymentSelection(current, paymentCapabilities);
      return reconciled.method === current.method && reconciled.scope === current.scope
        ? current
        : reconciled;
    });
  }, [paymentCapabilities]);

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
      <Screen bleed>
        {/* [F-265] Cart was the ONLY white-headed tab — Home, Activity and
            Profile all open maroon. One app, one head. */}
        <GradientMasthead style={{ paddingTop: 64, paddingBottom: space.lg, paddingHorizontal: GUTTER }}>
          <T variant="micro" tone="onBrand">YOUR BASKET</T>
          <T variant="title" tone="onBrand" style={{ marginTop: 2 }}>Cart</T>
        </GradientMasthead>
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

  const items: any[] = c?.items ?? [];

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
  const displayedTip = checkoutTipAmount({
    pickupOrApptOnly: pickup || apptOnly,
    selectedTip,
    cartTip: c?.tipAmount,
  });
  const displayedTotal = c
    ? Math.max(
        0,
        (pickup
          ? c.totalAmount - c.deliveryFee
          : express && c.deliveryFee > 0
            ? c.expressTotal
            : c.totalAmount)
          - Number(c.tipAmount ?? 0)
          + displayedTip,
      )
    : 0;
  const choosePickup = () => {
    setFulfillment('PICKUP');
    setExpress(false); // express is a delivery speed
    // No rider on a pickup — clear the persisted convenience too. Checkout
    // still submits zero synchronously if this mutation is delayed or fails.
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
    const submittingPickup = pickup || (extra as any)?.fulfillmentSelections != null;
    const submittedTip = checkoutTipAmount({
      pickupOrApptOnly: apptOnly || submittingPickup,
      selectedTip,
      cartTip: c?.tipAmount,
    });
    const submittedMethod = checkoutPaymentMethod(effectivePaySelection, paymentCapabilities);
    placeOrder.mutate(
      {
        paymentMethod: submittedMethod,
        ...(express && !pickup ? { express: true } : {}),
        ...(apptPayload.length ? { appointments: apptPayload } : {}),
        ...(instructions.trim() && !pickup ? { deliveryInstructions: instructions.trim() } : {}),
        ...(asPickup ? { fulfillmentSelections: { [c.vendor.id]: 'PICKUP' } } : {}),
        ...(extra ?? {}),
        tipAmount: submittedTip,
      },
      {
        onSuccess: (data: any) => {
          haptic.success();
          setPlacedPickup(submittingPickup);
          const first = data?.orders?.[0];
          const paymentAction = paymentActionForCheckout(data ?? {}, submittedMethod);
          setPlacedOrderId(first?.id ?? null);
          setPlacedHeld(!!(first?.holdExpiresAt && new Date(first.holdExpiresAt) > new Date()));
          setPlacedAppt(apptPayload.length > 0);
          setPlacedSubmittedMethod(submittedMethod);
          setPlacedPaymentAction(paymentAction);
          if (apptPayload.length) clearAppointments();
          // First order = the first moment notifications are obviously useful
          // [first-open SO-5]; primes once, never at boot.
          maybePrimeNotifications('customer_order');
          // The raw vendor field is never trusted/opened. Only the explicit,
          // validated post-checkout action can leave the app for MMG.
          // [WR-008] The auto-open used to discard failure — the order is
          // already committed, so a launch that silently does nothing left
          // the customer with no cue. The confirmation card's Pay button is
          // the durable path; point at it.
          if (paymentAction) {
            void openMmgPaymentAction(paymentAction).then((opened) => {
              if (!opened) toast.show("Couldn't open MMG — use the Pay button below.");
            });
          }
        },
        onError: (err: any) => {
          // Any server-side capability revalidation failure permanently
          // degrades this selection to cash for the current scope.
          const code = String(err?.response?.data?.error?.code ?? '');
          if (code.startsWith('MMG_')) {
            setPaySelection(selectCartPaymentMethod('CASH', paymentCapabilities));
          }
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
    <Screen bleed>
      {/* [F-265] The maroon masthead, same anatomy as the other tabs; the
          overflow (clear cart) rides inside it. */}
      <GradientMasthead style={{ paddingTop: 64, paddingBottom: space.lg, paddingHorizontal: GUTTER }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <View>
            <T variant="micro" tone="onBrand">YOUR BASKET</T>
            <T variant="title" tone="onBrand" style={{ marginTop: 2 }}>Cart</T>
          </View>
          <CircleChip icon="more-horizontal" onPress={() => setMenuOpen(true)} />
        </View>
      </GradientMasthead>

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
                {/* [F-264] A cart line is the last look someone gets before
                    paying — it must show what they are actually buying, or
                    nothing. */}
                <Photo
                  uri={itemPhoto(it)}
                  label={it.name}
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
                    selected={(selectedTip ?? Number(c.tipAmount)) === t}
                    onPress={() => {
                      setSelectedTip(t);
                      setTip.mutate(t);
                    }}
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
            <CartPaymentOptions
              capabilities={paymentCapabilities}
              selection={effectivePaySelection}
              appointmentOnly={apptOnly}
              pickup={pickup}
              onSelect={(method) => setPaySelection(selectCartPaymentMethod(method, paymentCapabilities))}
            />
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
              {!apptOnly && !pickup && displayedTip > 0 ? <InfoRow label="Rider tip" value={money(displayedTip)} /> : null}
              <View style={{ height: 1, backgroundColor: color.border.subtle, marginVertical: space.sm }} />
              {/* Pickup preview = the same server numbers minus the delivery
                  leg; the server prices the real order at place time. */}
              <InfoRow
                label={pickup ? 'Total at the counter' : 'Total'}
                value={money(displayedTotal)}
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
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Clear your cart?
        </PopupTitle>
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
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Promo applied!
        </PopupTitle>
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
        <DecorativeIcon
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
        </DecorativeIcon>
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          {placedAppt ? 'Booking requested' : 'Your order is placed'}
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          {placedOrderConfirmationCopy({
            appointment: placedAppt,
            pickup: placedPickup,
            held: placedHeld,
            submittedMethod: placedSubmittedMethod,
            paymentAction: placedPaymentAction,
          })}
        </T>
        {placedPaymentAction ? (
          <PillButton
            label="Pay business with MMG"
            icon="external-link"
            size="md"
            onPress={async () => {
              if (!(await openMmgPaymentAction(placedPaymentAction))) {
                toast.show(`Couldn't open MMG — open the MMG app and pay ${placedPaymentAction.recipientName} directly.`);
              }
            }}
            style={{ alignSelf: 'stretch', marginTop: space.xl }}
          />
        ) : null}
        <PillButton
          label={placedAppt ? 'View booking' : 'Track order'}
          size="md"
          onPress={() => {
            const id = placedOrderId;
            placeOrder.reset();
            if (id) navigation.navigate('Delivery', { orderId: id });
          }}
          style={{ alignSelf: 'stretch', marginTop: placedPaymentAction ? space.md : space.xl }}
        />
      </PopupCard>
    </Screen>
  );
}
