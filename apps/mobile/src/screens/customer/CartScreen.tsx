import { View, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, Heading, Card, Button, Spinner } from '../../components/ui';
import { useCart, useUpdateCartItem, useRemoveCartItem, useClearCart } from '../../hooks';
import { money } from '../../lib/money';

function CartHeader({ navigation, title, onClear }: any) {
  return (
    <View className="flex-row items-center justify-between px-lg py-sm">
      <Pressable onPress={() => navigation?.goBack?.()} hitSlop={8}>
        <Text className="text-2xl">‹ Back</Text>
      </Pressable>
      <Text className="flex-1 px-md text-base font-semibold" numberOfLines={1}>
        {title}
      </Text>
      {onClear ? (
        <Pressable onPress={onClear} hitSlop={8}>
          <Text className="text-sm text-text-muted">Clear</Text>
        </Pressable>
      ) : (
        <View />
      )}
    </View>
  );
}

function QtyBtn({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="h-8 w-8 items-center justify-center rounded-full border border-border-strong"
    >
      <Text className="text-lg font-semibold text-text-primary">{label}</Text>
    </Pressable>
  );
}

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text className={bold ? 'text-base font-semibold' : 'text-sm text-text-secondary'}>{label}</Text>
      <Text className={bold ? 'text-base font-semibold' : 'text-sm text-text-primary'}>{value}</Text>
    </View>
  );
}

export function CartScreen({ navigation }: any) {
  const { data: cart, isLoading } = useCart<any>();
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveCartItem();
  const clearCart = useClearCart();
  const busy = updateItem.isPending || removeItem.isPending || clearCart.isPending;

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const items: any[] = cart?.items ?? [];
  if (!cart || items.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <CartHeader navigation={navigation} title="Your cart" />
        <View className="flex-1 items-center justify-center px-2xl">
          <Text className="text-5xl">🛒</Text>
          <Heading size="lg" className="mt-md">
            Your cart is empty
          </Heading>
          <Text className="mt-xs text-center text-text-secondary">Find something tasty or handy nearby.</Text>
          <Button label="Explore" className="mt-lg px-2xl" onPress={() => navigation?.navigate?.('Tabs')} />
        </View>
      </SafeAreaView>
    );
  }

  const meetsMin = cart.meetsMinimum !== false;
  const shortfall = Math.max(0, Number(cart.vendor?.minOrderAmount ?? 0) - Number(cart.subtotalCustomer ?? 0));

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <CartHeader navigation={navigation} title={cart.vendor?.name ?? 'Your cart'} onClear={() => clearCart.mutate()} />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 170 }} showsVerticalScrollIndicator={false}>
        <View className="px-lg pt-sm">
          {items.map((it) => (
            <Card key={it.id} className="mb-md">
              <View className="flex-row items-start justify-between">
                <View className="flex-1 pr-md">
                  <Text className="text-base font-semibold">{it.name}</Text>
                  <Text className="mt-xs text-sm text-text-secondary">{money(it.customerPrice ?? it.basePrice)}</Text>
                  {it.isAvailable === false ? (
                    <Text className="mt-xs text-xs text-error">Unavailable — remove to checkout</Text>
                  ) : null}
                </View>
                <Text className="text-base font-semibold">{money(it.lineTotal)}</Text>
              </View>
              <View className="mt-sm flex-row items-center justify-between">
                <View className="flex-row items-center">
                  <QtyBtn
                    label="−"
                    disabled={busy}
                    onPress={() =>
                      it.quantity > 1
                        ? updateItem.mutate({ id: it.id, quantity: it.quantity - 1 })
                        : removeItem.mutate(it.id)
                    }
                  />
                  <Text className="mx-md text-base font-semibold">{it.quantity}</Text>
                  <QtyBtn label="+" disabled={busy} onPress={() => updateItem.mutate({ id: it.id, quantity: it.quantity + 1 })} />
                </View>
                <Pressable disabled={busy} onPress={() => removeItem.mutate(it.id)} hitSlop={8}>
                  <Text className="text-sm text-text-muted">Remove</Text>
                </Pressable>
              </View>
            </Card>
          ))}

          <Card className="mt-sm">
            <SummaryRow label="Subtotal" value={money(cart.subtotalCustomer)} />
            <SummaryRow label="Delivery" value={money(cart.deliveryFee)} />
            {cart.tipAmount ? <SummaryRow label="Tip" value={money(cart.tipAmount)} /> : null}
            {cart.discount ? <SummaryRow label="Discount" value={`− ${money(cart.discount)}`} /> : null}
            <View className="mt-sm border-t border-border-subtle pt-sm">
              <SummaryRow label="Total" value={money(cart.totalAmount)} bold />
            </View>
          </Card>
          <Text className="mt-sm px-xs text-xs text-text-muted">Cash on delivery · No platform fees.</Text>
        </View>
      </ScrollView>

      <View className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-base px-lg pb-2xl pt-md">
        {!meetsMin ? (
          <Text className="mb-sm text-center text-sm text-text-secondary">
            Add {money(shortfall)} more to reach the minimum.
          </Text>
        ) : null}
        <Button disabled={!meetsMin || busy} onPress={() => navigation?.navigate?.('Checkout')}>
          <View className="w-full flex-row items-center justify-between">
            <Text className="font-body font-semibold text-white">Go to checkout</Text>
            <Text className="font-body font-semibold text-white">{money(cart.totalAmount)}</Text>
          </View>
        </Button>
      </View>
    </SafeAreaView>
  );
}
