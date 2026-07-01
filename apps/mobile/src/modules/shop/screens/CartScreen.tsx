import { memo } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, Button, Spinner, List, Image, PressableScale, EmptyState, elevation } from '../../../components/ui';
import { useCart, useUpdateCartItem, useRemoveCartItem, useClearCart } from '../../../hooks';
import { money } from '../../../lib/money';
import { fallbackImage, kindForVendor } from '../../../lib/images';

function CartHeader({ navigation, title, onClear }: any) {
  return (
    <View className="flex-row items-center justify-between px-lg py-sm">
      <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
        <Feather name="chevron-left" size={24} color={color.text.primary} />
      </PressableScale>
      <Text className="flex-1 px-md text-base font-bold" numberOfLines={1}>{title}</Text>
      {onClear ? (
        <PressableScale onPress={onClear} hitSlop={8}>
          <Text className="text-sm font-semibold text-brand-500">Clear</Text>
        </PressableScale>
      ) : (
        <View style={{ width: 24 }} />
      )}
    </View>
  );
}

function QtyBtn({ icon, onPress, disabled }: { icon: 'minus' | 'plus'; onPress: () => void; disabled?: boolean }) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      className="h-8 w-8 items-center justify-center rounded-full border border-border-strong"
    >
      <Feather name={icon} size={16} color={color.text.primary} />
    </PressableScale>
  );
}

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text className={bold ? 'text-base font-semibold' : 'text-sm text-text-secondary'}>{label}</Text>
      <Text className={bold ? 'text-base font-extrabold text-brand-600' : 'text-sm text-text-primary'}>{value}</Text>
    </View>
  );
}

const CartItemRow = memo(function CartItemRow({ item, busy, onDec, onInc, onRemove, kind }: any) {
  const unavailable = item.isAvailable === false;
  return (
    <View
      className="mb-md flex-row items-center rounded-3xl bg-surface-base p-md"
      style={elevation.card}
    >
      <Image source={{ uri: item.imageUrl || fallbackImage(item.itemId ?? item.id, kind) }} style={{ width: 76, height: 76, borderRadius: 16 }} />
      <View className="flex-1 px-md">
        <Text className="text-base font-semibold text-text-primary" numberOfLines={1}>{item.name}</Text>
        {item.selectedOptionNames?.length ? (
          <Text className="mt-xs text-xs text-text-muted" numberOfLines={2}>{item.selectedOptionNames.join(' · ')}</Text>
        ) : null}
        {item.specialInstructions ? (
          <Text className="mt-xs text-xs italic text-text-muted" numberOfLines={1}>“{item.specialInstructions}”</Text>
        ) : null}
        <Text className="mt-xs text-sm text-text-secondary">{money(item.customerPrice ?? item.basePrice)}</Text>
        {unavailable ? <Text className="mt-xs text-xs text-error">Unavailable — remove to checkout</Text> : null}
        <View className="mt-sm flex-row items-center">
          <QtyBtn icon="minus" disabled={busy} onPress={onDec} />
          <Text className="mx-md text-base font-semibold text-text-primary">{item.quantity}</Text>
          <QtyBtn icon="plus" disabled={busy} onPress={onInc} />
        </View>
      </View>
      <View className="items-end">
        <Text className="text-base font-extrabold text-brand-600">{money(item.lineTotal)}</Text>
        <PressableScale disabled={busy} onPress={onRemove} hitSlop={8} className="mt-md">
          <Feather name="trash-2" size={18} color={color.text.muted} />
        </PressableScale>
      </View>
    </View>
  );
});

export function CartScreen({ navigation }: any) {
  const { data: cart, isLoading } = useCart<any>();
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveCartItem();
  const clearCart = useClearCart();
  const busy = updateItem.isPending || removeItem.isPending || clearCart.isPending;

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const items: any[] = cart?.items ?? [];
  if (!cart || items.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
        <CartHeader navigation={navigation} title="Your cart" />
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon="cart-outline"
            title="Your cart is empty"
            body="Find something tasty or handy nearby."
            actionLabel="Explore"
            onAction={() => navigation?.navigate?.('Tabs')}
          />
        </View>
      </SafeAreaView>
    );
  }

  const meetsMin = cart.meetsMinimum !== false;
  const hasUnavailable = items.some((it: any) => it.isAvailable === false);
  const shortfall = Math.max(0, Number(cart.vendor?.minOrderAmount ?? 0) - Number(cart.subtotalCustomer ?? 0));
  const isService = cart.vendor?.vendorType === 'SERVICE';
  const kind = kindForVendor(cart.vendor);

  const Summary = (
    <View>
      <Card className="mt-sm">
        <SummaryRow label="Subtotal" value={money(cart.subtotalCustomer)} />
        {cart.deliveryFee ? <SummaryRow label="Delivery" value={money(cart.deliveryFee)} /> : null}
        {cart.tipAmount ? <SummaryRow label="Tip" value={money(cart.tipAmount)} /> : null}
        {cart.discount ? <SummaryRow label="Discount" value={`− ${money(cart.discount)}`} /> : null}
        <View className="mt-sm border-t border-border-subtle pt-sm">
          <SummaryRow label="Total" value={money(cart.totalAmount)} bold />
        </View>
      </Card>
      <Text className="mt-sm px-xs text-xs text-text-muted">Cash on {isService ? 'completion' : 'delivery'} · No platform fees.</Text>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <CartHeader navigation={navigation} title={cart.vendor?.name ?? 'Your cart'} onClear={() => clearCart.mutate()} />
      <View style={{ flex: 1 }}>
        <List
          data={items}
          keyExtractor={(it: any) => String(it.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 170 }}
          ListHeaderComponent={
            <View className="mb-md flex-row items-center rounded-2xl bg-surface-base px-lg py-sm" style={elevation.card}>
              <Feather name="check-circle" size={15} color={color.success} />
              <Text className="ml-sm flex-1 text-xs font-semibold text-text-secondary">
                $0 platform fees — you pay the vendor’s price, cash on delivery.
              </Text>
            </View>
          }
          ListFooterComponent={Summary}
          renderItem={({ item: it }: { item: any }) => (
            <CartItemRow
              item={it}
              busy={busy}
              kind={kind}
              onDec={() => (it.quantity > 1 ? updateItem.mutate({ id: it.id, quantity: it.quantity - 1 }) : removeItem.mutate(it.id))}
              onInc={() => updateItem.mutate({ id: it.id, quantity: it.quantity + 1 })}
              onRemove={() => removeItem.mutate(it.id)}
            />
          )}
        />
      </View>

      <View className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-base px-lg pb-2xl pt-md">
        {hasUnavailable ? (
          <Text className="mb-sm text-center text-sm text-error">Remove unavailable items to continue.</Text>
        ) : !meetsMin ? (
          <Text className="mb-sm text-center text-sm text-text-secondary">Add {money(shortfall)} more to reach the minimum.</Text>
        ) : null}
        <Button disabled={!meetsMin || busy || hasUnavailable} onPress={() => navigation?.navigate?.('Checkout')}>
          <View className="w-full flex-row items-center justify-between">
            <Text className="font-body font-semibold text-white">{isService ? 'Continue' : 'Go to checkout'}</Text>
            <Text className="font-body font-semibold text-white">{money(cart.totalAmount)}</Text>
          </View>
        </Button>
      </View>
    </SafeAreaView>
  );
}
