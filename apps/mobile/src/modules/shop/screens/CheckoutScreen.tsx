import { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Spinner, PressableScale, ChoiceChip, Input, Badge, toast } from '../../../components/ui';
import { useCart, useAddresses, useSetCartAddress, useSetCartTip, usePlaceOrder, useItemSlots } from '../../../hooks';
import { customerApi } from '../../../services/api';
import { money } from '../../../lib/money';
import { pickOrderId } from '../../../lib/order';

const TIPS = [0, 200, 500, 1000];

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text className={bold ? 'text-base font-semibold' : 'text-sm text-text-secondary'}>{label}</Text>
      <Text style={bold ? { color: color.brand[600] } : undefined} className={bold ? 'text-base font-extrabold' : 'text-sm text-text-primary'}>{value}</Text>
    </View>
  );
}

export function CheckoutScreen({ navigation }: any) {
  const { data: cart, isLoading } = useCart<any>();
  const { data: addresses } = useAddresses<any[]>();
  const setAddress = useSetCartAddress();
  const setTip = useSetCartTip();
  const placeOrder = usePlaceOrder<any>();

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [selectedTip, setSelectedTip] = useState(0);
  // Promo codes (vendor + platform) — validated before ordering; the server
  // recomputes the authoritative discount at checkout.
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState<{ code: string; discount: number; description?: string } | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);

  const applyPromo = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code || promoBusy) return;
    setPromoBusy(true);
    setPromoError(null);
    try {
      const res = await customerApi.validatePromo(code);
      const data = res.data?.data ?? {};
      const discount = Number(data.estimatedDiscount ?? 0);
      setPromo({ code, discount, description: data.description });
      setPromoInput('');
      toast.success(`${code} applied`, discount > 0 ? `Saves ${money(discount)}` : data.description);
    } catch (e: any) {
      setPromo(null);
      setPromoError(e?.response?.data?.error?.message ?? e?.response?.data?.message ?? 'That code didn’t work');
    } finally {
      setPromoBusy(false);
    }
  };
  const [mode, setMode] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY');
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [selectedSlot, setSelectedSlot] = useState<string | undefined>(undefined);

  // Appointment carts (a SERVICE listing) book a time slot instead of delivering.
  const apptItem = cart?.items?.find((i: any) => i.fulfillment === 'APPOINTMENT');
  const isAppointment = !!apptItem;
  const { data: slotData, isLoading: slotsLoading } = useItemSlots<any>(apptItem?.itemId ?? '', isAppointment ? selectedDate : '');
  const slots: string[] = slotData?.slots ?? [];

  const list = addresses ?? [];
  const defaultAddressId = list.find((a: any) => a.isDefault)?.id ?? list[0]?.id;
  // Mirror the backend's default-address fallback (order.service: findFirst
  // isDefault) so a returning customer can check out immediately. Without this
  // the button stays disabled whenever the cart has no deliveryAddressId — e.g.
  // after "reorder" — even though the customer has a saved address.
  const effectiveAddressId = selectedId ?? cart?.deliveryAddressId ?? defaultAddressId;
  const isService = cart?.vendor?.vendorType === 'SERVICE';
  const vendorId: string | undefined = cart?.vendor?.id;
  // Takeaway is offered for goods vendors only (services are appointment-based).
  const canPickup = !isService && !!vendorId;
  const isPickup = mode === 'PICKUP' && canPickup;
  // Pickup carries no delivery fee, so the preview total drops it client-side too.
  const promoDiscount = promo?.discount ?? 0;
  const displayTotal = isPickup
    ? Number(cart?.subtotalCustomer ?? 0) + selectedTip - Number(cart?.discount ?? 0) - promoDiscount
    : Number(cart?.totalAmount ?? 0) - promoDiscount;

  useEffect(() => {
    // Persist the auto-selected default into the server cart so checkout uses
    // exactly the address shown as selected (the API only auto-falls-back to the
    // isDefault address, not to an arbitrary first one).
    if (!cart?.deliveryAddressId && !selectedId && defaultAddressId) {
      setAddress.mutate(defaultAddressId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only re-run when the resolved default / cart address changes
  }, [defaultAddressId, cart?.deliveryAddressId]);

  useEffect(() => {
    // Reflect a tip already on the cart so the selected pill matches the summary
    // and isn't silently reset to 0 when the order is placed.
    if (cart?.tipAmount != null) setSelectedTip(Number(cart.tipAmount));
  }, [cart?.tipAmount]);

  if (isLoading || !cart) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const onPlace = () => {
    placeOrder.mutate(
      {
        paymentMethod: 'CASH',
        tipAmount: selectedTip,
        ...(promo ? { promoCode: promo.code } : {}),
        ...(isPickup && vendorId ? { fulfillmentSelections: { [vendorId]: 'PICKUP' as const } } : {}),
        ...(isAppointment && apptItem && selectedSlot ? { appointments: [{ itemId: apptItem.itemId, slotStart: selectedSlot }] } : {}),
      },
      {
        onSuccess: (res: any) => {
          const orderId = pickOrderId(res);
          if (orderId) (navigation?.replace ?? navigation?.navigate)?.('OrderTracking', { id: orderId });
          else navigation?.navigate?.('Tabs');
        },
      },
    );
  };

  const dateOptions = Array.from({ length: 7 }, (_, i) => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
    return {
      value: d.toISOString().slice(0, 10),
      dow: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }),
      day: String(d.getUTCDate()),
    };
  });

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md text-base font-bold">Checkout</Text>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 170 }} showsVerticalScrollIndicator={false}>
        <View className="px-lg pt-sm">
          {/* Delivery vs Takeaway */}
          {canPickup ? (
            <View className="mb-lg flex-row" style={{ gap: 8 }}>
              <ChoiceChip label="Delivery" active={mode === 'DELIVERY'} onPress={() => setMode('DELIVERY')} full />
              <ChoiceChip label="Takeaway" active={mode === 'PICKUP'} onPress={() => setMode('PICKUP')} full />
            </View>
          ) : null}

          {/* Appointment slot picker, takeaway pickup, or delivery address */}
          {isAppointment ? (
            <>
              <Heading size="lg" className="mb-sm">Choose a date</Heading>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} className="mb-md">
                {dateOptions.map((d) => {
                  const on = d.value === selectedDate;
                  return (
                    <PressableScale
                      key={d.value}
                      onPress={() => { setSelectedDate(d.value); setSelectedSlot(undefined); }}
                      style={on ? { backgroundColor: color.brand[500] } : undefined}
              className={on ? 'items-center rounded-2xl px-lg py-md' : 'items-center rounded-2xl border border-border-subtle bg-surface-base px-lg py-md'}
                    >
                      <Text className={on ? 'text-xs font-semibold text-white' : 'text-xs font-semibold text-text-secondary'}>{d.dow}</Text>
                      <Text className={on ? 'mt-0.5 text-lg font-bold text-white' : 'mt-0.5 text-lg font-bold text-text-primary'}>{d.day}</Text>
                    </PressableScale>
                  );
                })}
              </ScrollView>
              <Heading size="lg" className="mb-sm">Choose a time</Heading>
              {slotsLoading ? (
                <View className="py-md"><Spinner /></View>
              ) : slots.length === 0 ? (
                <Text className="text-sm text-text-muted">No times available this day — try another date.</Text>
              ) : (
                <View className="flex-row flex-wrap" style={{ gap: 8 }}>
                  {slots.map((sISO) => {
                    const on = sISO === selectedSlot;
                    return (
                      <PressableScale
                        key={sISO}
                        onPress={() => setSelectedSlot(sISO)}
                        style={on ? { backgroundColor: color.brand[500] } : undefined}
                className={on ? 'rounded-full px-lg py-sm' : 'rounded-full border border-border-subtle bg-surface-base px-lg py-sm'}
                      >
                        <Text className={on ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-text-secondary'}>{sISO.slice(11, 16)}</Text>
                      </PressableScale>
                    );
                  })}
                </View>
              )}
            </>
          ) : isPickup ? (
            <>
              <Heading size="lg" className="mb-sm">Pick up from</Heading>
              <Card className="flex-row items-center">
                <MaterialCommunityIcons name="storefront-outline" size={20} color={color.brand[500]} />
                <View className="ml-sm flex-1">
                  <Text className="text-base font-semibold">{cart.vendor?.name ?? 'The store'}</Text>
                  <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                    {cart.vendor?.addressLine1 ?? 'Collect your order at the counter'}
                  </Text>
                </View>
              </Card>
              <Text className="mt-sm text-xs text-text-muted">
                We&apos;ll send a pickup code when your order is ready — show it to collect. No delivery fee.
              </Text>
            </>
          ) : (
          <>
          <Heading size="lg" className="mb-sm">{isService ? 'Service location' : 'Deliver to'}</Heading>
          {list.length === 0 ? (
            <PressableScale onPress={() => navigation?.navigate?.('AddAddress')}>
              <Card className="flex-row items-center">
                <Feather name="plus-circle" size={18} color={color.brand[500]} />
                <Text className="ml-sm font-semibold" style={{ color: color.brand[600] }}>{isService ? 'Add an address' : 'Add a delivery address'}</Text>
              </Card>
            </PressableScale>
          ) : (
            list.map((a) => {
              const active = a.id === effectiveAddressId;
              return (
                <PressableScale key={a.id} onPress={() => { setSelectedId(a.id); setAddress.mutate(a.id); }}>
                  {/* Kit selected-row language: soft brand tint, no border */}
                  <Card style={active ? { backgroundColor: color.brand[50] } : undefined} className="mb-sm">
                    <View className="flex-row items-center justify-between">
                      <View className="flex-1 pr-md">
                        <Text className="text-base font-semibold">{a.label || a.addressLine1}</Text>
                        <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                          {a.addressLine1}{a.city ? `, ${a.city}` : ''}
                        </Text>
                      </View>
                      <Feather name={active ? 'check-circle' : 'circle'} size={20} color={active ? color.brand[500] : color.text.muted} />
                    </View>
                  </Card>
                </PressableScale>
              );
            })
          )}
          </>
          )}

          {/* Payment — informational, not a choice (V1 is cash-only), so it stays
              quiet: no selected border, no check. */}
          <Heading size="lg" className="mb-sm mt-lg">Payment</Heading>
          <Card>
            <View className="flex-row items-center">
              <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-subtle">
                <MaterialCommunityIcons name="cash" size={20} color={color.success} />
              </View>
              <View className="ml-md flex-1">
                <Text className="text-base font-semibold">
                  {isService ? 'Cash on completion' : isPickup ? 'Cash on pickup' : 'Cash on delivery'}
                </Text>
                <Text className="mt-0.5 text-xs text-text-muted">
                  {isService
                    ? 'Pay in cash when the service is done. No platform fees.'
                    : isPickup
                      ? 'Pay in cash when you collect. No platform fees.'
                      : 'Pay the rider in cash. No card needed, no platform fees.'}
                </Text>
              </View>
            </View>
          </Card>

          {/* Tip */}
          <Heading size="lg" className="mb-sm mt-lg">{isService ? 'Add a tip' : 'Tip your rider'}</Heading>
          <View className="flex-row" style={{ gap: 8 }}>
            {TIPS.map((t) => (
              <ChoiceChip
                key={t}
                label={t === 0 ? 'None' : money(t)}
                active={t === selectedTip}
                onPress={() => { setSelectedTip(t); setTip.mutate(t); }}
                full
              />
            ))}
          </View>

          {/* Promo code */}
          <Heading size="lg" className="mb-sm mt-lg">Promo code</Heading>
          <Card>
            {promo ? (
              <View className="flex-row items-center">
                <Badge label={promo.code} tone="success" />
                <Text className="ml-sm flex-1 text-sm text-text-secondary" numberOfLines={1}>
                  {promo.description ?? 'Applied'} · saves {money(promo.discount)}
                </Text>
                <PressableScale onPress={() => setPromo(null)} hitSlop={8}>
                  <Feather name="x" size={16} color={color.text.muted} />
                </PressableScale>
              </View>
            ) : (
              <View className="flex-row items-center" style={{ gap: 8 }}>
                <Input
                  containerClassName="flex-1"
                  value={promoInput}
                  onChangeText={setPromoInput}
                  placeholder="Have a code? (e.g. SAVE20)"
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                <Button label="Apply" variant="outline" loading={promoBusy} disabled={!promoInput.trim()} onPress={applyPromo} />
              </View>
            )}
            {promoError ? <Text className="mt-sm text-sm text-error">{promoError}</Text> : null}
          </Card>

          {/* Summary */}
          <Card className="mt-lg">
            <SummaryRow label="Subtotal" value={money(cart.subtotalCustomer)} />
            {!isPickup && cart.deliveryFee ? <SummaryRow label="Delivery" value={money(cart.deliveryFee)} /> : null}
            {cart.tipAmount ? <SummaryRow label="Tip" value={money(cart.tipAmount)} /> : null}
            {cart.discount ? <SummaryRow label="Discount" value={`− ${money(cart.discount)}`} /> : null}
            {promo ? <SummaryRow label={`Promo ${promo.code}`} value={`− ${money(promo.discount)}`} /> : null}
            <View className="mt-sm border-t border-border-subtle pt-sm">
              <SummaryRow label="Total" value={money(displayTotal)} bold />
            </View>
          </Card>
        </View>
      </ScrollView>

      <View
        className="absolute inset-x-0 bottom-0 bg-surface-base px-lg pb-2xl pt-md"
        style={{ shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.1, shadowRadius: 18, elevation: 14 }}
      >
        {placeOrder.isError ? (
          (placeOrder.error as any)?.response?.data?.code === 'ID_VERIFICATION_REQUIRED' ? (
            <View className="mb-sm">
              <Text className="mb-sm text-center text-sm text-text-secondary">
                {(placeOrder.error as any)?.response?.data?.message ?? 'This order needs ID verification.'}
              </Text>
              <Button label="Verify your ID" variant="outline" onPress={() => navigation?.navigate?.('IdentityVerification')} />
            </View>
          ) : (
            <Text className="mb-sm text-center text-sm text-error">Couldn&apos;t place order. Please try again.</Text>
          )
        ) : null}
        <Button
          loading={placeOrder.isPending}
          disabled={isAppointment ? !selectedSlot : !isPickup && (list.length === 0 || !effectiveAddressId)}
          onPress={onPlace}
        >
          <Text className="font-body font-semibold text-white">
            {isAppointment && !selectedSlot ? 'Pick a time' : `Place order · ${money(displayTotal)}`}
          </Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
