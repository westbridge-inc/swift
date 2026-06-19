import { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Spinner } from '../../components/ui';
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

  const list = addresses ?? [];
  const effectiveAddressId = selectedId ?? cart?.deliveryAddressId;

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
      { paymentMethod: 'CASH', tipAmount: selectedTip },
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
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </Pressable>
        <Text className="ml-md text-base font-bold">Checkout</Text>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 170 }} showsVerticalScrollIndicator={false}>
        <View className="px-lg pt-sm">
          {/* Address */}
          <Heading size="lg" className="mb-sm">Deliver to</Heading>
          {list.length === 0 ? (
            <Pressable onPress={() => navigation?.navigate?.('AddAddress')}>
              <Card className="flex-row items-center">
                <Feather name="plus-circle" size={18} color={color.brand[500]} />
                <Text className="ml-sm font-semibold text-brand-600">Add a delivery address</Text>
              </Card>
            </Pressable>
          ) : (
            list.map((a) => {
              const active = a.id === effectiveAddressId;
              return (
                <Pressable key={a.id} onPress={() => { setSelectedId(a.id); setAddress.mutate(a.id); }}>
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
                </Pressable>
              );
            })
          )}

          {/* Payment */}
          <Heading size="lg" className="mb-sm mt-lg">Payment</Heading>
          <Card className="border-brand-500">
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center">
                <MaterialCommunityIcons name="cash" size={22} color={color.success} />
                <Text className="ml-sm text-base font-semibold">Cash on delivery</Text>
              </View>
              <Feather name="check-circle" size={20} color={color.brand[500]} />
            </View>
            <Text className="mt-xs text-xs text-text-muted">Pay the rider in cash. No card needed, no platform fees.</Text>
          </Card>

          {/* Tip */}
          <Heading size="lg" className="mb-sm mt-lg">Tip your rider</Heading>
          <View className="flex-row" style={{ gap: 8 }}>
            {TIPS.map((t) => {
              const active = t === selectedTip;
              return (
                <Pressable
                  key={t}
                  onPress={() => { setSelectedTip(t); setTip.mutate(t); }}
                  className={active ? 'flex-1 items-center rounded-lg border border-brand-500 bg-brand-50 py-sm' : 'flex-1 items-center rounded-lg border border-border-subtle py-sm'}
                >
                  <Text className={active ? 'font-semibold text-brand-600' : 'text-text-secondary'}>{t === 0 ? 'None' : money(t)}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* Summary */}
          <Card className="mt-lg">
            <SummaryRow label="Subtotal" value={money(cart.subtotalCustomer)} />
            <SummaryRow label="Delivery" value={money(cart.deliveryFee)} />
            {cart.tipAmount ? <SummaryRow label="Tip" value={money(cart.tipAmount)} /> : null}
            {cart.discount ? <SummaryRow label="Discount" value={`− ${money(cart.discount)}`} /> : null}
            <View className="mt-sm border-t border-border-subtle pt-sm">
              <SummaryRow label="Total" value={money(cart.totalAmount)} bold />
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
        <Button disabled={placeOrder.isPending || list.length === 0 || !effectiveAddressId} onPress={onPlace}>
          <Text className="font-body font-semibold text-white">
            {placeOrder.isPending ? 'Placing…' : `Place order · ${money(cart.totalAmount)}`}
          </Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
