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
import { useAuthStore } from '../../../stores/authStore';
import { useLocationStore } from '../../../stores/locationStore';
import { DARK_BLURHASH, itemImage } from '../../../lib/images';
import { money } from '../../../lib/money';
import {
  Card,
  Chip,
  CircleChip,
  EmptyState,
  ErrorState,
  IconChip,
  InfoRow,
  LabeledInput,
  LoadingBlock,
  PillButton,
  PopupCard,
  QtyStepper,
  Screen,
  T,
} from '../../../kit';

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [placedOrderId, setPlacedOrderId] = useState<string | null>(null);

  const applyPromo = useMutation({
    mutationFn: (code: string) => customerApi.validatePromo(code),
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
          <T variant="heading">My Cart</T>
        </View>
        <EmptyState
          icon="shopping-bag"
          title="Sign in to start a cart"
          body="Your basket lives on your account so it follows you between devices."
          actionLabel="Sign In"
          onAction={promptLogin}
        />
      </Screen>
    );
  }

  const c = cart.data; // null = empty cart
  const items: any[] = c?.items ?? [];

  const onOrder = () => {
    placeOrder.mutate(
      {
        paymentMethod: 'CASH',
        ...(instructions.trim() ? { deliveryInstructions: instructions.trim() } : {}),
      },
      {
        onSuccess: (data: any) => {
          const first = data?.orders?.[0];
          setPlacedOrderId(first?.id ?? null);
        },
      },
    );
  };

  const orderErr = placeOrder.isError
    ? ((placeOrder.error as any)?.response?.data?.error?.message ?? 'Could not place the order. Try again.')
    : undefined;

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
        <T variant="heading">My Cart</T>
        <CircleChip icon="more-horizontal" onPress={() => setMenuOpen(true)} />
      </View>

      {cart.isLoading ? (
        <LoadingBlock />
      ) : cart.isError ? (
        <ErrorState onRetry={() => cart.refetch()} />
      ) : !c || items.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space['3xl'] }}>
          <T style={{ fontSize: 96, lineHeight: 110 }}>🍕</T>
          <T variant="title" center style={{ marginTop: space.lg }}>
            Your cart is empty!
          </T>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm, maxWidth: 280 }}>
            It appears that no food has been ordered yet
          </T>
          <PillButton
            label="Find Foods"
            onPress={() => navigation.navigate('Search')}
            style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          />
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Delivery location */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm }}>
            <View style={{ flex: 1 }}>
              <T variant="label" tone="muted">
                Delivery Location
              </T>
              <T variant="body" weight="semibold" style={{ marginTop: 2 }} numberOfLines={1}>
                {c.deliveryAddress?.label ?? c.deliveryAddress?.addressLine1 ?? 'No address yet'}
              </T>
            </View>
            <PillButton
              label={c.deliveryAddress ? 'Change Location' : 'Add Address'}
              variant="soft"
              size="sm"
              onPress={() => navigation.navigate('Addresses', { selectFor: 'cart' })}
            />
          </View>

          {/* Promo code (kit 31–32) — server-applied via validate */}
          <View style={{ marginTop: space.xl }}>
            <LabeledInput
              icon="tag"
              placeholder="Promo Code..."
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
                  style={{ width: 76, height: 76, borderRadius: radius.full }}
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
                  <T variant="label" weight="bold" tone="brand">
                    {money(it.customerPrice)}
                  </T>
                  {!it.isAvailable ? (
                    <T variant="caption" tone="error">
                      No longer available — remove to continue
                    </T>
                  ) : null}
                  <View style={{ marginTop: 4 }}>
                    <QtyStepper
                      value={it.quantity}
                      min={1}
                      onDec={() => it.quantity > 1 && updateItem.mutate({ id: it.id, quantity: it.quantity - 1 })}
                      onInc={() => updateItem.mutate({ id: it.id, quantity: it.quantity + 1 })}
                    />
                  </View>
                </View>
                <Pressable onPress={() => removeItem.mutate(it.id)} hitSlop={8}>
                  {({ pressed }) => <Feather name="trash-2" size={20} color={pressed ? color.brand[600] : color.error} />}
                </Pressable>
              </Card>
            ))}
          </View>

          {/* Tip the rider (real cart-level tip) */}
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
                style={{ height: 40, paddingHorizontal: space.lg }}
              />
            ))}
          </View>

          {/* Delivery instructions */}
          <View style={{ marginTop: space.xl }}>
            <LabeledInput
              icon="message-square"
              placeholder="Delivery instructions (optional)"
              value={instructions}
              onChangeText={setInstructions}
            />
          </View>

          {/* Payment fact — V1 is cash on delivery */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              marginTop: space.xl,
              padding: space.lg,
              borderRadius: radius.md,
              backgroundColor: color.brand[50],
            }}
          >
            <Feather name="dollar-sign" size={16} color={color.brand[600]} />
            <T variant="label" tone="deep" style={{ flex: 1 }}>
              Cash on delivery — pay the rider when your order arrives.
            </T>
          </View>

          {/* Order summary */}
          <Card style={{ marginTop: space.xl }}>
            <T variant="heading">Order Summary</T>
            <View style={{ marginTop: space.md }}>
              <InfoRow label={`Total Items (${c.itemCount})`} value={money(c.subtotalCustomer)} />
              <InfoRow label="Delivery Fee" value={c.deliveryFee === 0 ? 'Free' : money(c.deliveryFee)} />
              {c.discount > 0 ? <InfoRow label="Discount" value={`-${money(c.discount)}`} /> : null}
              {Number(c.tipAmount) > 0 ? <InfoRow label="Rider Tip" value={money(c.tipAmount)} /> : null}
              <View style={{ height: 1, backgroundColor: color.border.subtle, marginVertical: space.sm }} />
              <InfoRow label="Total" value={money(c.totalAmount)} strong />
            </View>
            {c.estimatedTotalMin ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                Estimated arrival ~{c.estimatedTotalMin} min after the store confirms.
              </T>
            ) : null}
          </Card>

          {!c.meetsMinimum ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.md }}>
              <Feather name="alert-circle" size={14} color={color.error} />
              <T variant="label" tone="error">
                This store has a minimum order of {money(c.minimumOrderAmount)}.
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

          <PillButton
            label="Order Now"
            onPress={onOrder}
            loading={placeOrder.isPending}
            disabled={!c.meetsMinimum || c.unavailableItemIds?.length > 0 || !c.deliveryAddress}
            style={{ marginTop: space.xl }}
          />
          {!c.deliveryAddress ? (
            <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
              Add a delivery address to place the order.
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
            label="Clear Cart"
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
        <PillButton label="Nice" size="md" onPress={() => setPromoPopup(false)} style={{ alignSelf: 'stretch', marginTop: space.xl }} />
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
          Your order is placed
        </T>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          The store has been notified — pay cash on delivery.
        </T>
        <PillButton
          label="Track Order"
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
