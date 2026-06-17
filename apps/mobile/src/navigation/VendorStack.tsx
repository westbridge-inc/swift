import React, { useState } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Spinner, Badge } from '../components/ui';
import { DocumentChecklist } from '../components/onboarding/DocumentChecklist';
import { useBecomePartner, useVerificationStatus } from '../hooks/verification';
import { useVendorProfile, useVendorOrders, useToggleOpen, useToggleOrders, useOrderAction } from '../hooks/vendorops';
import { useAuthStore } from '../stores/authStore';
import { useLocationStore } from '../stores/locationStore';
import { money } from '../lib/money';

const Stack = createNativeStackNavigator();
const FIELD = 'mb-sm rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary';

const TYPES = [
  { key: 'RESTAURANT', label: 'Restaurant' },
  { key: 'SUPERMARKET', label: 'Grocery' },
  { key: 'STORE', label: 'Shop' },
  { key: 'SERVICE', label: 'Services' },
] as const;

function Header({ title }: { title: string }) {
  const { logout } = useAuthStore();
  return (
    <View className="flex-row items-center justify-between px-lg py-sm">
      <Heading size="2xl" className="flex-1 pr-md" numberOfLines={1}>
        {title}
      </Heading>
      <Pressable onPress={logout} hitSlop={8}>
        <Text className="text-sm text-text-muted">Log out</Text>
      </Pressable>
    </View>
  );
}

function BusinessSetup() {
  const become = useBecomePartner();
  const { latitude, longitude } = useLocationStore();
  const [name, setName] = useState('');
  const [type, setType] = useState<'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE'>('RESTAURANT');
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState('');
  const [city, setCity] = useState('Georgetown');
  const valid = name.trim().length >= 2 && phone.trim().length >= 5 && addr.trim().length >= 3 && city.trim().length >= 2;

  const submit = () => {
    become.mutate({
      role: 'VENDOR',
      business: {
        name: name.trim(),
        vendorType: type,
        phone: phone.trim(),
        addressLine1: addr.trim(),
        city: city.trim(),
        latitude: latitude ?? 6.8013,
        longitude: longitude ?? -58.1551,
      },
    });
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <Header title="Sell on Swift" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Text className="mb-md text-sm text-text-secondary">
          Tell us about your business. We&apos;ll use your current location as the store address.
        </Text>
        <Text className="mb-xs text-sm font-semibold text-text-secondary">Business type</Text>
        <View className="mb-md flex-row flex-wrap" style={{ gap: 8 }}>
          {TYPES.map((t) => {
            const active = t.key === type;
            return (
              <Pressable
                key={t.key}
                onPress={() => setType(t.key)}
                className={active ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm' : 'rounded-lg border border-border-subtle px-lg py-sm'}
              >
                <Text className={active ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput value={name} onChangeText={setName} placeholder="Business name" placeholderTextColor={color.text.muted} className={FIELD} />
        <TextInput value={phone} onChangeText={setPhone} placeholder="Business phone" placeholderTextColor={color.text.muted} keyboardType="phone-pad" className={FIELD} />
        <TextInput value={addr} onChangeText={setAddr} placeholder="Street address" placeholderTextColor={color.text.muted} className={FIELD} />
        <TextInput value={city} onChangeText={setCity} placeholder="City" placeholderTextColor={color.text.muted} className={FIELD} />
        {become.isError ? <Text className="mb-sm text-sm text-error">Couldn&apos;t create your store. Try again.</Text> : null}
        <Button label={become.isPending ? 'Creating…' : 'Create store'} disabled={!valid || become.isPending} onPress={submit} />
      </ScrollView>
    </SafeAreaView>
  );
}

function VendorOnboarding({ store }: { store: any }) {
  const { data: status } = useVerificationStatus<any>(store.vendorType);
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <Header title={store.name} />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <View className="mb-md flex-row items-start rounded-lg bg-brand-50 px-lg py-md">
          <Text className="text-base">🛡️</Text>
          <Text className="ml-sm flex-1 text-sm text-brand-700">
            Your store is under review. Upload your business documents — we approve within 24 hours, then you can take orders.
          </Text>
        </View>
        <DocumentChecklist role={store.vendorType} status={status} />
      </ScrollView>
    </SafeAreaView>
  );
}

function orderActions(status: string): { label: string; action: 'accept' | 'preparing' | 'ready' | 'reject' }[] {
  const s = (status || '').toUpperCase();
  if (s === 'PENDING' || s === 'PLACED') return [{ label: 'Accept', action: 'accept' }, { label: 'Reject', action: 'reject' }];
  if (s === 'ACCEPTED' || s === 'CONFIRMED') return [{ label: 'Start preparing', action: 'preparing' }];
  if (s === 'PREPARING') return [{ label: 'Mark ready', action: 'ready' }];
  return [];
}

function VendorOps({ store }: { store: any }) {
  const toggleOpen = useToggleOpen();
  const toggleOrders = useToggleOrders();
  const orderAction = useOrderAction();
  const ordersQ = useVendorOrders(true);
  const orders: any[] = ordersQ.data ?? [];
  const open = !!store.isCurrentlyOpen;
  const accepting = !!store.acceptingOrders;
  const busy = orderAction.isPending;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <Header title={store.name} />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Card className="mb-md">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-base font-semibold">Store {open ? 'open' : 'closed'}</Text>
              <Text className="mt-xs text-xs text-text-muted">{accepting ? 'Accepting orders' : 'Not accepting orders'}</Text>
            </View>
            <Badge label={open ? 'Open' : 'Closed'} tone={open ? 'success' : 'brand'} />
          </View>
          <View className="mt-md flex-row" style={{ gap: 8 }}>
            <Button label={open ? 'Close store' : 'Open store'} variant="outline" className="flex-1" disabled={toggleOpen.isPending} onPress={() => toggleOpen.mutate()} />
            <Button label={accepting ? 'Pause orders' : 'Resume orders'} variant="outline" className="flex-1" disabled={toggleOrders.isPending} onPress={() => toggleOrders.mutate()} />
          </View>
        </Card>

        <Heading size="lg" className="mb-sm mt-md">
          Incoming orders
        </Heading>
        {orders.length === 0 ? (
          <Text className="mt-md text-center text-text-secondary">No active orders right now.</Text>
        ) : (
          orders.map((o) => {
            const actions = orderActions(o.status);
            return (
              <Card key={o.id} className="mb-md">
                <View className="flex-row items-center justify-between">
                  <Text className="text-base font-semibold">{o.orderNumber ? `#${o.orderNumber}` : 'Order'}</Text>
                  <Badge label={String(o.status ?? '').replace(/_/g, ' ').toLowerCase()} tone="brand" />
                </View>
                <Text className="mt-xs text-sm text-text-secondary">
                  {(o.itemCount ?? o.items?.length ?? 0)} item{(o.itemCount ?? o.items?.length ?? 0) === 1 ? '' : 's'} · {money(o.totalAmount ?? o.total)}
                </Text>
                {actions.length > 0 ? (
                  <View className="mt-sm flex-row" style={{ gap: 8 }}>
                    {actions.map((a) => (
                      <Button
                        key={a.action}
                        label={a.label}
                        variant={a.action === 'reject' ? 'outline' : 'solid'}
                        className="flex-1"
                        disabled={busy}
                        onPress={() => orderAction.mutate({ id: o.id, action: a.action })}
                      />
                    ))}
                  </View>
                ) : null}
              </Card>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function VendorRoot() {
  const { store, isLoading } = useVendorProfile();

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }
  if (!store) return <BusinessSetup />;
  if (store.status !== 'ACTIVE') return <VendorOnboarding store={store} />;
  return <VendorOps store={store} />;
}

export function VendorStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="VendorRoot" component={VendorRoot} />
    </Stack.Navigator>
  );
}
