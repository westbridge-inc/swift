import { memo, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Card, Button, Spinner, List, Image, PressableScale, EmptyState, ConfirmDialog, elevation } from '../../../components/ui';
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
          <Text className="text-sm font-semibold" style={{ color: color.brand[500] }}>Clear</Text>
        </PressableScale>
      ) : (
        <View style={{ width: 24 }} />
      )}
    </View>
  );
}

/** One pill for quantity: minus becomes a trash glyph at qty 1 (tap = remove). */
function QtyStepper({ qty, busy, onDec, onInc }: { qty: number; busy?: boolean; onDec: () => void; onInc: () => void }) {
  return (
    <View className="flex-row items-center rounded-full border border-border-strong bg-surface-base" style={{ height: 34 }}>
      <PressableScale onPress={onDec} disabled={busy} hitSlop={8} className="h-full items-center justify-center pl-md pr-sm">
        <Feather name={qty <= 1 ? 'trash-2' : 'minus'} size={14} color={color.text.primary} />
      </PressableScale>
      <Text className="text-sm font-semibold text-text-primary" style={{ minWidth: 18, textAlign: 'center' }}>{qty}</Text>
      <PressableScale onPress={onInc} disabled={busy} hitSlop={8} className="h-full items-center justify-center pl-sm pr-md">
        <Feather name="plus" size={14} color={color.text.primary} />
      </PressableScale>
    </View>
  );
}

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View className="flex-row items-center justify-between py-1">
      <Text className={bold ? 'text-base font-semibold' : 'text-sm text-text-secondary'}>{label}</Text>
      <Text style={bold ? { color: color.brand[600] } : undefined} className={bold ? 'text-base font-extrabold' : 'text-sm text-text-primary'}>{value}</Text>
    </View>
  );
}

const CartItemRow = memo(function CartItemRow({ item, busy, onDec, onInc, kind }: any) {
  const unavailable = item.isAvailable === false;
  return (
    <View
      className="mb-md flex-row border border-border-subtle bg-surface-base p-md"
      style={[elevation.card, { borderRadius: 12 }, unavailable ? { opacity: 0.65 } : null]}
    >
      <Image source={{ uri: item.imageUrl || fallbackImage(item.itemId ?? item.id, kind) }} style={{ width: 64, height: 64, borderRadius: 8 }} />
      <View className="flex-1 px-md">
        <Text className="font-semibold text-text-primary" style={{ fontSize: 15 }} numberOfLines={1}>{item.name}</Text>
        {item.selectedOptionNames?.length ? (
          <Text className="mt-xs text-xs text-text-muted" numberOfLines={2}>{item.selectedOptionNames.join(' · ')}</Text>
        ) : null}
        {item.specialInstructions ? (
          <Text className="mt-xs text-xs italic text-text-muted" numberOfLines={1}>“{item.specialInstructions}”</Text>
        ) : null}
        <Text className="mt-xs text-sm text-text-secondary">{money(item.customerPrice ?? item.basePrice)}</Text>
        {unavailable ? <Text className="mt-xs text-xs text-error">Unavailable — remove to checkout</Text> : null}
      </View>
      <View className="items-end justify-between">
        <Text className="font-bold" style={{ fontSize: 15, color: color.brand[500] }}>{money(item.lineTotal)}</Text>
        <QtyStepper qty={item.quantity} busy={busy} onDec={onDec} onInc={onInc} />
      </View>
    </View>
  );
});

export function CartScreen({ navigation }: any) {
  const { data: cart, isLoading } = useCart<any>();
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveCartItem();
  const clearCart = useClearCart();
  const [confirmClear, setConfirmClear] = useState(false);
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
  const vendorId: string | undefined = cart.vendor?.id;

  const Footer = (
    <View>
      {vendorId ? (
        <PressableScale
          onPress={() => navigation?.navigate?.('VendorDetail', { id: vendorId })}
          className="flex-row items-center justify-center border border-border-subtle bg-surface-base py-md"
          style={{ borderRadius: 12 }}
        >
          <Feather name="plus" size={15} color={color.brand[500]} />
          <Text className="ml-sm text-sm font-semibold" style={{ color: color.brand[500] }}>Add more items</Text>
        </PressableScale>
      ) : null}
      <Card className="mt-md">
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
      <CartHeader navigation={navigation} title={cart.vendor?.name ?? 'Your cart'} onClear={() => setConfirmClear(true)} />
      <View style={{ flex: 1 }}>
        <List
          data={items}
          keyExtractor={(it: any) => String(it.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 170 }}
          ListHeaderComponent={
            <View className="mb-md flex-row items-center px-xs">
              <Feather name="check-circle" size={14} color={color.success} />
              <Text className="ml-sm flex-1 text-xs font-medium text-text-secondary">
                $0 platform fees — you pay the vendor’s price.
              </Text>
            </View>
          }
          ListFooterComponent={Footer}
          renderItem={({ item: it }: { item: any }) => (
            <CartItemRow
              item={it}
              busy={busy}
              kind={kind}
              onDec={() => (it.quantity > 1 ? updateItem.mutate({ id: it.id, quantity: it.quantity - 1 }) : removeItem.mutate(it.id))}
              onInc={() => updateItem.mutate({ id: it.id, quantity: it.quantity + 1 })}
            />
          )}
        />
      </View>

      <View
        className="absolute inset-x-0 bottom-0 bg-surface-base px-lg pb-2xl pt-md"
        style={{ shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.1, shadowRadius: 18, elevation: 14 }}
      >
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

      <ConfirmDialog
        open={confirmClear}
        title="Empty your cart?"
        body="This removes everything in your cart."
        confirmLabel="Empty cart"
        destructive
        loading={clearCart.isPending}
        onConfirm={() => {
          setConfirmClear(false);
          clearCart.mutate();
        }}
        onClose={() => setConfirmClear(false)}
      />
    </SafeAreaView>
  );
}
