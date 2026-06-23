import { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Spinner, PressableScale, ChoiceChip } from '../../components/ui';
import { useCart, useAddresses, useSetCartAddress, useSetCartTip, usePlaceOrder } from '../../hooks';
import { money } from '../../lib/money';

const TIPS = [0, 200, 500, 1000];

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text className={bold ? 'text-base font-semibold' : 'text-sm text-text-secondary'}>{label}</Text>
      <Text className={bold ? 'text-base font-semibold' : 'text-sm text-text-primary'}>{value}</Text>
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
  const [mode, setMode] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY');

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
  const displayTotal = isPickup
    ? Number(cart?.subtotalCustomer ?? 0) + selectedTip - Number(cart?.discount ?? 0)
    : Number(cart?.totalAmount ?? 0);

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
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
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
        ...(isPickup && vendorId ? { fulfillmentSelections: { [vendorId]: 'PICKUP' as const } } : {}),
      },
      {
        onSuccess: (res: any) => {
          const orderId = res?.orders?.[0]?.id ?? res?.order?.id;
          if (orderId) (navigation?.replace ?? navigation?.navigate)?.('OrderTracking', { id: orderId });
          else navigation?.navigate?.('Tabs');
        },
      },
    );
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
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

          {/* Address (delivery) or pickup location (takeaway) */}
          {isPickup ? (
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
                <Text className="ml-sm font-semibold text-brand-600">{isService ? 'Add an address' : 'Add a delivery address'}</Text>
              </Card>
            </PressableScale>
          ) : (
            list.map((a) => {
              const active = a.id === effectiveAddressId;
              return (
                <PressableScale key={a.id} onPress={() => { setSelectedId(a.id); setAddress.mutate(a.id); }}>
                  <Card className={active ? 'mb-sm border-brand-500' : 'mb-sm'}>
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

          {/* Payment */}
          <Heading size="lg" className="mb-sm mt-lg">Payment</Heading>
          <Card className="border-brand-500">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center">
                <MaterialCommunityIcons name="cash" size={22} color={color.success} />
                <Text className="ml-sm text-base font-semibold">
                  {isService ? 'Cash on completion' : isPickup ? 'Cash on pickup' : 'Cash on delivery'}
                </Text>
              </View>
              <Feather name="check-circle" size={20} color={color.brand[500]} />
            </View>
            <Text className="mt-xs text-xs text-text-muted">
              {isService
                ? 'Pay in cash when the service is done. No platform fees.'
                : isPickup
                  ? 'Pay in cash when you collect. No platform fees.'
                  : 'Pay the rider in cash. No card needed, no platform fees.'}
            </Text>
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

          {/* Summary */}
          <Card className="mt-lg">
            <SummaryRow label="Subtotal" value={money(cart.subtotalCustomer)} />
            {!isPickup && cart.deliveryFee ? <SummaryRow label="Delivery" value={money(cart.deliveryFee)} /> : null}
            {cart.tipAmount ? <SummaryRow label="Tip" value={money(cart.tipAmount)} /> : null}
            {cart.discount ? <SummaryRow label="Discount" value={`− ${money(cart.discount)}`} /> : null}
            <View className="mt-sm border-t border-border-subtle pt-sm">
              <SummaryRow label="Total" value={money(displayTotal)} bold />
            </View>
          </Card>
        </View>
      </ScrollView>

      <View className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-base px-lg pb-2xl pt-md">
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
          disabled={!isPickup && (list.length === 0 || !effectiveAddressId)}
          onPress={onPlace}
        >
          <Text className="font-body font-semibold text-white">Place order · {money(displayTotal)}</Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
