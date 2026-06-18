import React, { useState } from 'react';
import { View, ScrollView, Pressable, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, Badge } from '../components/ui';
import { DocumentChecklist } from '../components/onboarding/DocumentChecklist';
import { useBecomePartner, useVerificationStatus } from '../hooks/verification';
import {
  useVendorProfile,
  useVendorOrders,
  useToggleOpen,
  useToggleOrders,
  useOrderAction,
  useVendorMenu,
  useCreateCategory,
  useSaveItem,
  useDeleteItem,
  useSetItemAvailability,
} from '../hooks/vendorops';
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
          <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[600]} />
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

function VendorOps({ store, navigation }: any) {
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

        <Button
          label="Manage menu"
          variant="outline"
          className="mb-md"
          onPress={() => navigation.navigate('VendorMenu')}
        />

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

function VendorRoot({ navigation }: any) {
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
  return <VendorOps store={store} navigation={navigation} />;
}

// ─── Menu management ─────────────────────────────────────────────────────────

function SubHeader({
  title,
  navigation,
  action,
}: {
  title: string;
  navigation: any;
  action?: { label: string; onPress: () => void; disabled?: boolean };
}) {
  return (
    <View className="flex-row items-center justify-between px-lg py-sm">
      <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
        <Feather name="chevron-left" size={22} color={color.brand[600]} />
      </Pressable>
      <Heading size="lg" className="flex-1 px-md text-center" numberOfLines={1}>
        {title}
      </Heading>
      {action ? (
        <Pressable onPress={action.onPress} disabled={action.disabled} hitSlop={8}>
          <Text className={action.disabled ? 'text-base text-text-muted' : 'text-base font-semibold text-brand-600'}>
            {action.label}
          </Text>
        </Pressable>
      ) : (
        <View style={{ width: 48 }} />
      )}
    </View>
  );
}

function MenuItemRow({
  item,
  navigation,
  categories,
}: {
  item: any;
  navigation: any;
  categories: { id: string; name: string }[];
}) {
  const setAvail = useSetItemAvailability();
  const del = useDeleteItem();
  const available = item.isAvailable !== false;

  const confirmDelete = () =>
    Alert.alert('Delete item', `Remove "${item.name}" from your menu?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => del.mutate(item.id) },
    ]);

  return (
    <Card className="mb-sm">
      <View className="flex-row items-center justify-between">
        <View className="flex-1 pr-md">
          <Text className="text-base font-semibold" numberOfLines={1}>
            {item.name}
          </Text>
          <Text className="mt-xs text-sm text-text-secondary">{money(item.basePrice)}</Text>
        </View>
        <Pressable
          onPress={() => setAvail.mutate({ id: item.id, isAvailable: !available })}
          disabled={setAvail.isPending}
          hitSlop={6}
          className={
            available
              ? 'rounded-full bg-success/10 px-3 py-1'
              : 'rounded-full border border-border-subtle bg-surface-base px-3 py-1'
          }
        >
          <Text className={available ? 'text-xs font-semibold text-success' : 'text-xs font-semibold text-text-muted'}>
            {available ? 'Available' : 'Sold out'}
          </Text>
        </Pressable>
      </View>
      <View className="mt-sm flex-row" style={{ gap: 8 }}>
        <Button
          label="Edit"
          variant="outline"
          className="flex-1"
          onPress={() => navigation.navigate('VendorItemEditor', { item, categories })}
        />
        <Button
          label={del.isPending ? 'Removing…' : 'Delete'}
          variant="outline"
          className="flex-1"
          disabled={del.isPending}
          onPress={confirmDelete}
        />
      </View>
    </Card>
  );
}

function VendorMenuScreen({ navigation }: any) {
  const menuQ = useVendorMenu();
  const createCategory = useCreateCategory();
  const [newCat, setNewCat] = useState('');
  const categories: any[] = menuQ.data ?? [];
  const catOptions = categories.map((c) => ({ id: c.id, name: c.name }));

  const addCategory = () => {
    const name = newCat.trim();
    if (name.length < 1) return;
    createCategory.mutate({ name }, { onSuccess: () => setNewCat('') });
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <SubHeader
        title="Menu"
        navigation={navigation}
        action={
          catOptions.length > 0
            ? { label: '+ Item', onPress: () => navigation.navigate('VendorItemEditor', { categories: catOptions }) }
            : undefined
        }
      />
      {menuQ.isLoading ? (
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          <Card className="mb-md">
            <Text className="mb-xs text-sm font-semibold text-text-secondary">New category</Text>
            <View className="flex-row items-center" style={{ gap: 8 }}>
              <TextInput
                value={newCat}
                onChangeText={setNewCat}
                placeholder="e.g. Mains, Drinks"
                placeholderTextColor={color.text.muted}
                className="flex-1 rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary"
              />
              <Button label="Add" disabled={newCat.trim().length < 1 || createCategory.isPending} onPress={addCategory} />
            </View>
          </Card>

          {categories.length === 0 ? (
            <Text className="mt-lg text-center text-text-secondary">Add a category to start building your menu.</Text>
          ) : (
            categories.map((cat) => (
              <View key={cat.id} className="mb-md">
                <Heading size="lg" className="mb-sm">
                  {cat.name}
                </Heading>
                {(cat.items ?? []).length === 0 ? (
                  <Text className="mb-sm text-sm text-text-muted">No items yet.</Text>
                ) : (
                  cat.items.map((it: any) => (
                    <MenuItemRow key={it.id} item={it} navigation={navigation} categories={catOptions} />
                  ))
                )}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function VendorItemEditorScreen({ navigation, route }: any) {
  const existing = route.params?.item;
  const categories: { id: string; name: string }[] = route.params?.categories ?? [];
  const save = useSaveItem();
  const [name, setName] = useState<string>(existing?.name ?? '');
  const [price, setPrice] = useState<string>(existing ? String(existing.basePrice ?? '') : '');
  const [description, setDescription] = useState<string>(existing?.description ?? '');
  const [categoryId, setCategoryId] = useState<string>(existing?.categoryId ?? categories[0]?.id ?? '');
  const [available, setAvailable] = useState<boolean>(existing ? existing.isAvailable !== false : true);
  const [popular, setPopular] = useState<boolean>(!!existing?.isPopular);

  const priceNum = Number(price);
  const valid = name.trim().length >= 1 && Number.isFinite(priceNum) && priceNum >= 0 && !!categoryId;

  const submit = () => {
    if (!valid) return;
    save.mutate(
      {
        id: existing?.id,
        data: {
          categoryId,
          name: name.trim(),
          description: description.trim() || undefined,
          basePrice: priceNum,
          isAvailable: available,
          isPopular: popular,
        },
      },
      { onSuccess: () => navigation.goBack() },
    );
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <SubHeader title={existing ? 'Edit item' : 'New item'} navigation={navigation} />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <TextInput value={name} onChangeText={setName} placeholder="Item name" placeholderTextColor={color.text.muted} className={FIELD} />
        <TextInput
          value={price}
          onChangeText={setPrice}
          placeholder="Price (GYD)"
          placeholderTextColor={color.text.muted}
          keyboardType="decimal-pad"
          className={FIELD}
        />
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Description (optional)"
          placeholderTextColor={color.text.muted}
          multiline
          className={FIELD}
        />

        <Text className="mb-xs mt-sm text-sm font-semibold text-text-secondary">Category</Text>
        <View className="mb-md flex-row flex-wrap" style={{ gap: 8 }}>
          {categories.map((c) => {
            const active = c.id === categoryId;
            return (
              <Pressable
                key={c.id}
                onPress={() => setCategoryId(c.id)}
                className={active ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm' : 'rounded-lg border border-border-subtle px-lg py-sm'}
              >
                <Text className={active ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>{c.name}</Text>
              </Pressable>
            );
          })}
        </View>

        <View className="mb-md flex-row" style={{ gap: 8 }}>
          <Pressable
            onPress={() => setAvailable((v) => !v)}
            className={available ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm' : 'rounded-lg border border-border-subtle px-lg py-sm'}
          >
            <Text className={available ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>
              {available ? 'Available' : 'Sold out'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setPopular((v) => !v)}
            className={popular ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm' : 'rounded-lg border border-border-subtle px-lg py-sm'}
          >
            <Text className={popular ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>★ Popular</Text>
          </Pressable>
        </View>

        {save.isError ? <Text className="mb-sm text-sm text-error">Couldn&apos;t save. Check the details and try again.</Text> : null}
        <Button
          label={save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Add item'}
          disabled={!valid || save.isPending}
          onPress={submit}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

export function VendorStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="VendorRoot" component={VendorRoot} />
      <Stack.Screen name="VendorMenu" component={VendorMenuScreen} />
      <Stack.Screen name="VendorItemEditor" component={VendorItemEditorScreen} />
    </Stack.Navigator>
  );
}
