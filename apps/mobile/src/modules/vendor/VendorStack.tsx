import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { View, ScrollView, TextInput, Alert, Switch, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, Skeleton, Image, Badge, elevation, PressableScale, EmptyState } from '../../components/ui';
import { DocumentChecklist } from '../../components/onboarding/DocumentChecklist';
import { useBecomePartner, useVerificationStatus } from '../../hooks/verification';
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
  useUploadItemImage,
  useVendorSubscription,
  useVendorAnalytics,
  useVendorHours,
  useSetHours,
  type DayHours,
} from '../../hooks/vendorops';
import { useAuthStore } from '../../stores/authStore';
import { useLocationStore } from '../../stores/locationStore';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { money } from '../../lib/money';
import { mediaUrl } from '../../lib/images';
import * as ImagePicker from 'expo-image-picker';
import { VendorBulkImportScreen } from '../../screens/vendor/VendorBulkImportScreen';

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
      <PressableScale onPress={logout} hitSlop={8}>
        <Text className="text-sm text-text-muted">Log out</Text>
      </PressableScale>
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
              <PressableScale
                key={t.key}
                onPress={() => setType(t.key)}
                className={active ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm' : 'rounded-lg border border-border-subtle px-lg py-sm'}
              >
                <Text className={active ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>{t.label}</Text>
              </PressableScale>
            );
          })}
        </View>
        <TextInput value={name} onChangeText={setName} placeholder="Business name" placeholderTextColor={color.text.muted} className={FIELD} />
        <TextInput value={phone} onChangeText={setPhone} placeholder="Business phone" placeholderTextColor={color.text.muted} keyboardType="phone-pad" className={FIELD} />
        <TextInput value={addr} onChangeText={setAddr} placeholder="Street address" placeholderTextColor={color.text.muted} className={FIELD} />
        <TextInput value={city} onChangeText={setCity} placeholder="City" placeholderTextColor={color.text.muted} className={FIELD} />
        {become.isError ? <Text className="mb-sm text-sm text-error">Couldn&apos;t create your store. Try again.</Text> : null}
        <Button label="Create store" loading={become.isPending} disabled={!valid} onPress={submit} />
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

type VendorOrderActionKind = 'accept' | 'preparing' | 'ready' | 'reject' | 'complete-pickup';

function orderActions(order: any): { label: string; action: VendorOrderActionKind }[] {
  const s = (order?.status || '').toUpperCase();
  const isPickup = order?.fulfillment === 'PICKUP';
  if (s === 'PENDING' || s === 'PLACED') return [{ label: 'Accept', action: 'accept' }, { label: 'Reject', action: 'reject' }];
  if (s === 'ACCEPTED' || s === 'CONFIRMED') return [{ label: 'Start preparing', action: 'preparing' }];
  if (s === 'PREPARING') return [{ label: isPickup ? 'Ready for pickup' : 'Mark ready', action: 'ready' }];
  // Takeaway: the vendor closes the order when the customer collects it (no rider).
  if ((s === 'READY' || s === 'READY_FOR_PICKUP') && isPickup) return [{ label: 'Mark picked up', action: 'complete-pickup' }];
  return [];
}

const CARD_SHADOW = elevation.raised;

function timeAgo(iso?: string) {
  if (!iso) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

const ORDER_PILL: Record<string, { label: string; bg: string; fg: string }> = {
  PENDING: { label: 'New', bg: 'bg-brand-500', fg: 'text-white' },
  PLACED: { label: 'New', bg: 'bg-brand-500', fg: 'text-white' },
  ACCEPTED: { label: 'Accepted', bg: 'bg-brand-50', fg: 'text-brand-600' },
  CONFIRMED: { label: 'Accepted', bg: 'bg-brand-50', fg: 'text-brand-600' },
  PREPARING: { label: 'Preparing', bg: 'bg-surface-subtle', fg: 'text-text-secondary' },
  READY: { label: 'Ready', bg: 'bg-success/10', fg: 'text-success' },
};

function StatusPill({ status }: { status: string }) {
  const s = (status || '').toUpperCase();
  const cfg = ORDER_PILL[s] ?? { label: s.replace(/_/g, ' ').toLowerCase(), bg: 'bg-surface-subtle', fg: 'text-text-secondary' };
  return (
    <View className={`self-start rounded-full px-3 py-1 ${cfg.bg}`}>
      <Text className={`text-xs font-semibold ${cfg.fg}`}>{cfg.label}</Text>
    </View>
  );
}

function KpiTile({ icon, value, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; value: string; label: string }) {
  return (
    <View className="flex-1 rounded-2xl bg-surface-base p-md" style={CARD_SHADOW}>
      <MaterialCommunityIcons name={icon} size={18} color={color.brand[500]} />
      <Text className="mt-xs text-lg font-bold text-text-primary" numberOfLines={1}>{value}</Text>
      <Text className="text-xs text-text-muted" numberOfLines={1}>{label}</Text>
    </View>
  );
}

function VendorOrderCard({
  order,
  onAction,
  busy,
}: {
  order: any;
  onAction: (action: VendorOrderActionKind) => void;
  busy: boolean;
}) {
  const actions = orderActions(order);
  const items = order.itemCount ?? order.items?.length ?? 0;
  const isPickup = order.fulfillment === 'PICKUP';
  return (
    <View className="mb-md rounded-2xl bg-surface-base p-lg" style={CARD_SHADOW}>
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center" style={{ gap: 8 }}>
          <Text className="text-base font-bold text-text-primary">{order.orderNumber ? `#${order.orderNumber}` : 'Order'}</Text>
          {isPickup ? (
            <View className="flex-row items-center rounded-full bg-surface-subtle px-2 py-0.5">
              <MaterialCommunityIcons name="bag-personal-outline" size={12} color={color.brand[500]} />
              <Text className="ml-1 text-xs font-semibold text-brand-600">Takeaway</Text>
            </View>
          ) : null}
        </View>
        <StatusPill status={order.status} />
      </View>
      <View className="mt-xs flex-row items-center">
        <Feather name="clock" size={13} color={color.text.muted} />
        <Text className="ml-1 text-xs text-text-muted">{timeAgo(order.placedAt)}</Text>
        {items ? <Text className="ml-2 text-xs text-text-muted">{`· ${items} item${items === 1 ? '' : 's'}`}</Text> : null}
        <Text className="ml-2 text-xs text-text-muted">{`· ${order.paymentMethod === 'CASH' ? 'Cash' : order.paymentMethod ?? ''}`}</Text>
      </View>
      {isPickup && order.pickupCode ? (
        <View className="mt-sm flex-row items-center">
          <MaterialCommunityIcons name="form-textbox-password" size={13} color={color.text.muted} />
          <Text className="ml-1 text-sm text-text-secondary">Pickup code </Text>
          <Text className="text-sm font-bold text-brand-600">{order.pickupCode}</Text>
        </View>
      ) : !isPickup && order.deliveryAddress ? (
        <View className="mt-sm flex-row items-center">
          <Feather name="map-pin" size={13} color={color.text.muted} />
          <Text className="ml-1 flex-1 text-sm text-text-secondary" numberOfLines={1}>{order.deliveryAddress}</Text>
        </View>
      ) : null}
      <Text className="mt-sm text-lg font-bold text-text-primary">{money(order.totalAmount ?? order.total)}</Text>
      {actions.length > 0 ? (
        <View className="mt-md flex-row" style={{ gap: 8 }}>
          {actions.map((a) => (
            <Button
              key={a.action}
              label={a.label}
              variant={a.action === 'reject' ? 'outline' : 'solid'}
              className="flex-1"
              disabled={busy}
              onPress={() => onAction(a.action)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function VendorOps({ store, navigation }: any) {
  const toggleOpen = useToggleOpen();
  const toggleOrders = useToggleOrders();
  const orderAction = useOrderAction();
  const ordersQ = useVendorOrders(true);
  const { stores } = useVendorProfile();
  const setSelectedStore = useStoreSwitcher((s) => s.setSelectedStore);
  const qc = useQueryClient();
  const switchStore = (id: string) => {
    setSelectedStore(id);
    qc.invalidateQueries({ queryKey: ['vendor'] });
  };
  const orders: any[] = ordersQ.data ?? [];
  const open = !!store.isCurrentlyOpen;
  const accepting = !!store.acceptingOrders;
  const busy = orderAction.isPending;

  const isNew = (s: string) => ['PENDING', 'PLACED'].includes((s || '').toUpperCase());
  const newOrders = orders.filter((o) => isNew(o.status));
  const inProgress = orders.filter((o) => !isNew(o.status));
  const queueValue = orders.reduce((sum, o) => sum + Number(o.totalAmount ?? o.total ?? 0), 0);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <Header title={store.name} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={ordersQ.isRefetching} onRefresh={() => ordersQ.refetch()} tintColor={color.brand[500]} />}
      >
        {/* Multi-store switcher — only when the owner has more than one store. */}
        {stores.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-md" contentContainerStyle={{ gap: 8 }}>
            {stores.map((s: any) => {
              const active = s.id === store.id;
              return (
                <PressableScale
                  key={s.id}
                  onPress={() => switchStore(s.id)}
                  className={active ? 'rounded-full bg-brand-500 px-lg py-sm' : 'rounded-full border border-border-subtle bg-surface-base px-lg py-sm'}
                >
                  <Text className={active ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-text-secondary'} numberOfLines={1}>
                    {s.name}
                  </Text>
                </PressableScale>
              );
            })}
          </ScrollView>
        ) : null}

        {/* Store status */}
        <Card className="mb-md">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-md">
              <View className="flex-row items-center">
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: open && accepting ? color.success : color.text.muted }} />
                <Text className="ml-2 text-base font-bold text-text-primary">
                  {!open ? 'Store closed' : accepting ? 'Open for orders' : 'Orders paused'}
                </Text>
              </View>
              <Text className="mt-xs text-xs text-text-muted">
                {!open ? 'Outside business hours' : accepting ? 'Accepting new orders' : 'You’re open but not taking new orders'}
              </Text>
            </View>
            <Switch
              value={open}
              onValueChange={() => toggleOpen.mutate()}
              disabled={toggleOpen.isPending}
              trackColor={{ true: color.brand[500], false: color.border.subtle }}
            />
          </View>
          <Button
            label={accepting ? 'Pause new orders' : 'Resume orders'}
            variant="outline"
            className="mt-md"
            loading={toggleOrders.isPending}
            onPress={() => toggleOrders.mutate()}
          />
        </Card>

        {/* KPIs */}
        <View className="mb-md flex-row" style={{ gap: 8 }}>
          <KpiTile icon="receipt" value={String(orders.length)} label="Active orders" />
          <KpiTile icon="cash" value={money(queueValue)} label="In queue" />
          <KpiTile icon="timer-outline" value={`${store.estimatedPrepTime ?? 30}m`} label="Prep time" />
        </View>

        <Button label="Manage menu & inventory" variant="outline" className="mb-lg" onPress={() => navigation.navigate('Menu')} />

        {/* New orders */}
        <Heading size="lg" className="mb-sm">{newOrders.length ? `New orders · ${newOrders.length}` : 'New orders'}</Heading>
        {ordersQ.isLoading ? (
          <>
            <Skeleton className="mb-md h-28 w-full rounded-2xl" />
            <Skeleton className="mb-md h-28 w-full rounded-2xl" />
          </>
        ) : newOrders.length === 0 ? (
          <View className="mb-lg items-center rounded-2xl bg-surface-subtle py-xl">
            <MaterialCommunityIcons name="check-circle-outline" size={28} color={color.text.muted} />
            <Text className="mt-sm text-sm text-text-secondary">You are all caught up</Text>
          </View>
        ) : (
          newOrders.map((o) => (
            <VendorOrderCard key={o.id} order={o} busy={busy} onAction={(action) => orderAction.mutate({ id: o.id, action })} />
          ))
        )}

        {/* In progress */}
        {inProgress.length > 0 ? (
          <>
            <Heading size="lg" className="mb-sm mt-md">In progress</Heading>
            {inProgress.map((o) => (
              <VendorOrderCard key={o.id} order={o} busy={busy} onAction={(action) => orderAction.mutate({ id: o.id, action })} />
            ))}
          </>
        ) : null}
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
  return <VendorTabs />;
}

// ─── Menu management ─────────────────────────────────────────────────────────

function SubHeader({
  title,
  navigation,
  action,
  hideBack,
}: {
  title: string;
  navigation: any;
  action?: { label: string; onPress: () => void; disabled?: boolean };
  hideBack?: boolean;
}) {
  return (
    <View className="flex-row items-center justify-between px-lg py-sm">
      {hideBack ? (
        <View style={{ width: 22 }} />
      ) : (
        <PressableScale onPress={() => navigation.goBack()} hitSlop={8}>
          <Feather name="chevron-left" size={22} color={color.brand[600]} />
        </PressableScale>
      )}
      <Heading size="lg" className="flex-1 px-md text-center" numberOfLines={1}>
        {title}
      </Heading>
      {action ? (
        <PressableScale onPress={action.onPress} disabled={action.disabled} hitSlop={8}>
          <Text className={action.disabled ? 'text-base text-text-muted' : 'text-base font-semibold text-brand-600'}>
            {action.label}
          </Text>
        </PressableScale>
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
      <View className="flex-row items-center">
        {item.imageUrl ? (
          <Image source={{ uri: mediaUrl(item.imageUrl)! }} style={{ width: 52, height: 52, borderRadius: 10 }} />
        ) : (
          <View style={{ width: 52, height: 52, borderRadius: 10 }} className="items-center justify-center bg-surface-subtle">
            <Feather name="image" size={18} color={color.text.muted} />
          </View>
        )}
        <View className="ml-md flex-1">
          <Text className="text-base font-semibold" numberOfLines={1}>
            {item.name}
          </Text>
          <Text className="mt-xs text-sm text-text-secondary">
            {money(item.basePrice)}
            {item.stockQuantity != null ? ` · ${item.stockQuantity} in stock` : ''}
          </Text>
        </View>
        <PressableScale
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
        </PressableScale>
      </View>
      <View className="mt-sm flex-row" style={{ gap: 8 }}>
        <Button
          label="Edit"
          variant="outline"
          className="flex-1"
          onPress={() => navigation.navigate('VendorItemEditor', { item, categories })}
        />
        <Button
          label="Delete"
          variant="outline"
          className="flex-1"
          loading={del.isPending}
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
        title="Menu & inventory"
        navigation={navigation}
        hideBack
        action={
          catOptions.length > 0
            ? { label: '+ Item', onPress: () => navigation.navigate('VendorItemEditor', { categories: catOptions }) }
            : undefined
        }
      />
      {menuQ.isLoading ? (
        <View className="px-lg pt-md">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="mb-md h-16 w-full rounded-2xl" />
          ))}
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
              <Button label="Add" loading={createCategory.isPending} disabled={newCat.trim().length < 1} onPress={addCategory} />
            </View>
          </Card>

          <PressableScale onPress={() => navigation.navigate('VendorBulkImport')}>
            <Card className="mb-md flex-row items-center">
              <Feather name="upload-cloud" size={18} color={color.brand[500]} />
              <View className="ml-md flex-1">
                <Text className="text-base font-semibold">Bulk import catalogue</Text>
                <Text className="text-xs text-text-muted">Paste a CSV — we map the columns for you</Text>
              </View>
              <Feather name="chevron-right" size={18} color={color.text.muted} />
            </Card>
          </PressableScale>

          {categories.length === 0 ? (
            <EmptyState icon="silverware-variant" title="Build your menu" body="Add a category above, then start adding items." />
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
  const uploadImage = useUploadItemImage();
  const [name, setName] = useState<string>(existing?.name ?? '');
  const [price, setPrice] = useState<string>(existing ? String(existing.basePrice ?? '') : '');
  const [description, setDescription] = useState<string>(existing?.description ?? '');
  const [categoryId, setCategoryId] = useState<string>(existing?.categoryId ?? categories[0]?.id ?? '');
  const [available, setAvailable] = useState<boolean>(existing ? existing.isAvailable !== false : true);
  const [popular, setPopular] = useState<boolean>(!!existing?.isPopular);
  const [sku, setSku] = useState<string>(existing?.sku ?? '');
  const [unit, setUnit] = useState<string>(existing?.unit ?? '');
  const [stock, setStock] = useState<string>(existing?.stockQuantity != null ? String(existing.stockQuantity) : '');
  const [localPhoto, setLocalPhoto] = useState<{ uri: string; name: string; type: string } | null>(null);

  const priceNum = Number(price);
  const valid = name.trim().length >= 1 && Number.isFinite(priceNum) && priceNum >= 0 && !!categoryId;
  const busy = save.isPending || uploadImage.isPending;
  const previewUri = localPhoto?.uri ?? mediaUrl(existing?.imageUrl) ?? undefined;

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setLocalPhoto({ uri: a.uri, name: a.fileName ?? 'item.jpg', type: a.mimeType ?? 'image/jpeg' });
  };

  const submit = async () => {
    if (!valid || busy) return;
    const stockNum = stock.trim() === '' ? undefined : Number(stock);
    const saved: any = await save.mutateAsync({
      id: existing?.id,
      data: {
        categoryId,
        name: name.trim(),
        description: description.trim() || undefined,
        basePrice: priceNum,
        isAvailable: available,
        isPopular: popular,
        sku: sku.trim() || undefined,
        unit: unit.trim() || undefined,
        stockQuantity: Number.isFinite(stockNum as number) ? stockNum : undefined,
      },
    });
    const itemId = existing?.id ?? saved?.id;
    if (localPhoto && itemId) {
      // Item is already saved; a failed photo upload shouldn't block the flow.
      await uploadImage.mutateAsync({ id: itemId, file: localPhoto }).catch(() => undefined);
    }
    navigation.goBack();
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <SubHeader title={existing ? 'Edit item' : 'New item'} navigation={navigation} />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        {/* Photo */}
        <PressableScale onPress={pickPhoto} className="mb-sm items-center justify-center overflow-hidden rounded-2xl bg-surface-subtle" style={{ height: 160 }}>
          {previewUri ? (
            <Image source={{ uri: previewUri }} style={{ width: '100%', height: 160 }} />
          ) : (
            <View className="items-center">
              <Feather name="camera" size={24} color={color.text.muted} />
              <Text className="mt-xs text-sm text-text-muted">Add a photo</Text>
            </View>
          )}
        </PressableScale>
        {previewUri ? (
          <PressableScale onPress={pickPhoto} className="mb-md items-center" hitSlop={6} disabled={uploadImage.isPending}>
            <Text className="text-sm font-semibold text-brand-600">{uploadImage.isPending ? 'Uploading…' : 'Change photo'}</Text>
          </PressableScale>
        ) : null}

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

        {/* Inventory — used by groceries/shops; optional for restaurants */}
        <Text className="mb-xs mt-sm text-sm font-semibold text-text-secondary">Inventory (optional)</Text>
        <View className="flex-row" style={{ gap: 8 }}>
          <TextInput value={stock} onChangeText={setStock} placeholder="Stock qty" placeholderTextColor={color.text.muted} keyboardType="number-pad" className={`${FIELD} flex-1`} />
          <TextInput value={unit} onChangeText={setUnit} placeholder="Unit (kg, ea)" placeholderTextColor={color.text.muted} className={`${FIELD} flex-1`} />
        </View>
        <TextInput value={sku} onChangeText={setSku} placeholder="SKU / barcode (optional)" placeholderTextColor={color.text.muted} className={FIELD} />

        <Text className="mb-xs mt-sm text-sm font-semibold text-text-secondary">Category</Text>
        <View className="mb-md flex-row flex-wrap" style={{ gap: 8 }}>
          {categories.map((c) => {
            const active = c.id === categoryId;
            return (
              <PressableScale
                key={c.id}
                onPress={() => setCategoryId(c.id)}
                className={active ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm' : 'rounded-lg border border-border-subtle px-lg py-sm'}
              >
                <Text className={active ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>{c.name}</Text>
              </PressableScale>
            );
          })}
        </View>

        <View className="mb-md flex-row" style={{ gap: 8 }}>
          <PressableScale
            onPress={() => setAvailable((v) => !v)}
            className={available ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm' : 'rounded-lg border border-border-subtle px-lg py-sm'}
          >
            <Text className={available ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>
              {available ? 'Available' : 'Sold out'}
            </Text>
          </PressableScale>
          <PressableScale
            onPress={() => setPopular((v) => !v)}
            className={popular ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm' : 'rounded-lg border border-border-subtle px-lg py-sm'}
          >
            <Text className={popular ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>★ Popular</Text>
          </PressableScale>
        </View>

        {save.isError ? <Text className="mb-sm text-sm text-error">Couldn&apos;t save. Check the details and try again.</Text> : null}
        <Button
          label={existing ? 'Save changes' : 'Add item'}
          loading={busy}
          disabled={!valid}
          onPress={submit}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function prettyVendorType(t?: string) {
  return t === 'SUPERMARKET' ? 'Grocery' : t === 'STORE' ? 'Shop' : t === 'SERVICE' ? 'Services' : 'Restaurant';
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Orders tab — the (cached) store, then the live order board.
function VendorOrdersTab({ navigation }: any) {
  const { store } = useVendorProfile();
  if (!store) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }
  return <VendorOps store={store} navigation={navigation} />;
}

function VendorInsightsScreen() {
  const q = useVendorAnalytics();
  const a: any = q.data ?? {};
  const v: any = a.vendor ?? {};
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <Header title="Insights" />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={color.brand[500]} />}
      >
        {q.isLoading ? (
          <>
            <Skeleton className="mb-md h-24 w-full rounded-2xl" />
            <Skeleton className="mb-md h-24 w-full rounded-2xl" />
          </>
        ) : (
          <>
            <View className="mb-md flex-row" style={{ gap: 8 }}>
              <KpiTile icon="receipt" value={String(a.today?.orders ?? 0)} label="Orders today" />
              <KpiTile icon="cash" value={money(a.today?.revenue ?? 0)} label="Revenue today" />
            </View>
            <View className="mb-md flex-row" style={{ gap: 8 }}>
              <KpiTile icon="calendar-week" value={String(a.week?.orders ?? 0)} label="Orders / week" />
              <KpiTile icon="calendar-month" value={String(a.month?.orders ?? 0)} label="Orders / month" />
            </View>
            <Card className="mb-md">
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center">
                  <MaterialCommunityIcons name="star" size={18} color={color.brand[500]} />
                  <Text className="ml-2 text-base font-semibold">{Number(v.averageRating ?? 0).toFixed(1)}</Text>
                  <Text className="ml-1 text-sm text-text-muted">({v.totalRatings ?? 0})</Text>
                </View>
                <Text className="text-sm text-text-secondary">{v.totalOrders ?? 0} lifetime orders</Text>
              </View>
            </Card>
            <View className="flex-row" style={{ gap: 8 }}>
              <KpiTile icon="silverware-fork-knife" value={String(a.activeMenuItems ?? 0)} label="Active items" />
              <KpiTile icon="bell-ring" value={String(a.pendingOrders ?? 0)} label="Pending now" />
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function VendorAccountScreen() {
  const { store } = useVendorProfile();
  const sub = useVendorSubscription();
  const hoursQ = useVendorHours();
  const setHours = useSetHours();

  const [days, setDays] = useState<DayHours[]>([]);
  useEffect(() => {
    const byDay = new Map<number, DayHours>();
    for (const h of hoursQ.data ?? []) {
      if (!byDay.has(h.dayOfWeek)) {
        byDay.set(h.dayOfWeek, {
          dayOfWeek: h.dayOfWeek,
          openTime: h.openTime || '08:00',
          closeTime: h.closeTime || '22:00',
          isClosed: !!h.isClosed,
        });
      }
    }
    setDays(Array.from({ length: 7 }, (_, d) => byDay.get(d) ?? { dayOfWeek: d, openTime: '08:00', closeTime: '22:00', isClosed: false }));
  }, [hoursQ.data]);

  const setDay = (d: number, patch: Partial<DayHours>) =>
    setDays((prev) => prev.map((x) => (x.dayOfWeek === d ? { ...x, ...patch } : x)));

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <Header title="Account" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Card className="mb-md">
          <Text className="text-base font-bold text-text-primary">{store?.name ?? 'Your store'}</Text>
          <Text className="mt-xs text-sm text-text-secondary">
            {prettyVendorType(store?.vendorType)}
            {store?.city ? ` · ${store.city}` : ''}
          </Text>
          {store?.phone ? <Text className="mt-xs text-xs text-text-muted">{store.phone}</Text> : null}
        </Card>

        <Card className="mb-md">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-md">
              <Text className="text-base font-semibold">Subscription</Text>
              <Text className="mt-xs text-xs text-text-muted">
                {sub.data ? 'Active weekly plan' : 'No active plan — set up weekly billing'}
              </Text>
            </View>
            <Badge label={sub.data ? 'Active' : 'Inactive'} tone={sub.data ? 'success' : 'brand'} />
          </View>
        </Card>

        <Heading size="lg" className="mb-sm mt-sm">
          Business hours
        </Heading>
        {hoursQ.isLoading ? (
          <Skeleton className="mb-md h-48 w-full rounded-2xl" />
        ) : (
          <Card className="mb-md">
            {days.map((d) => (
              <View key={d.dayOfWeek} className="mb-sm flex-row items-center">
                <Text className="w-10 text-sm font-semibold text-text-primary">{DAY_LABELS[d.dayOfWeek]}</Text>
                {d.isClosed ? (
                  <Text className="flex-1 px-sm text-sm text-text-muted">Closed</Text>
                ) : (
                  <View className="flex-1 flex-row items-center px-sm" style={{ gap: 6 }}>
                    <TextInput
                      value={d.openTime}
                      onChangeText={(t) => setDay(d.dayOfWeek, { openTime: t })}
                      placeholder="08:00"
                      placeholderTextColor={color.text.muted}
                      className="flex-1 rounded-lg border border-border-subtle bg-surface-base px-sm py-sm text-center font-body text-sm text-text-primary"
                    />
                    <Text className="text-text-muted">–</Text>
                    <TextInput
                      value={d.closeTime}
                      onChangeText={(t) => setDay(d.dayOfWeek, { closeTime: t })}
                      placeholder="22:00"
                      placeholderTextColor={color.text.muted}
                      className="flex-1 rounded-lg border border-border-subtle bg-surface-base px-sm py-sm text-center font-body text-sm text-text-primary"
                    />
                  </View>
                )}
                <Switch
                  value={!d.isClosed}
                  onValueChange={(val) => setDay(d.dayOfWeek, { isClosed: !val })}
                  trackColor={{ true: color.brand[500], false: color.border.subtle }}
                />
              </View>
            ))}
            <Button
              label="Save hours"
              loading={setHours.isPending}
              className="mt-sm"
              disabled={days.length === 0}
              onPress={() => setHours.mutate(days)}
            />
            {setHours.isSuccess ? <Text className="mt-sm text-center text-xs text-success">Hours updated</Text> : null}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function MenuStackNav() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="VendorMenu" component={VendorMenuScreen} />
      <Stack.Screen name="VendorItemEditor" component={VendorItemEditorScreen} />
      <Stack.Screen name="VendorBulkImport" component={VendorBulkImportScreen} />
    </Stack.Navigator>
  );
}

const VTab = createBottomTabNavigator();

function VendorTabs() {
  return (
    <VTab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.brand[500],
        tabBarInactiveTintColor: color.text.muted,
        tabBarStyle: { backgroundColor: color.surface.base, borderTopColor: color.border.subtle },
      }}
    >
      <VTab.Screen
        name="Orders"
        component={VendorOrdersTab}
        options={{ tabBarLabel: 'Orders', tabBarIcon: ({ color: c, size }) => <Feather name="clipboard" size={size} color={c} /> }}
      />
      <VTab.Screen
        name="Menu"
        component={MenuStackNav}
        options={{ tabBarLabel: 'Menu', tabBarIcon: ({ color: c, size }) => <Feather name="book-open" size={size} color={c} /> }}
      />
      <VTab.Screen
        name="Insights"
        component={VendorInsightsScreen}
        options={{ tabBarLabel: 'Insights', tabBarIcon: ({ color: c, size }) => <Feather name="bar-chart-2" size={size} color={c} /> }}
      />
      <VTab.Screen
        name="Account"
        component={VendorAccountScreen}
        options={{ tabBarLabel: 'Account', tabBarIcon: ({ color: c, size }) => <Feather name="user" size={size} color={c} /> }}
      />
    </VTab.Navigator>
  );
}

export function VendorStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="VendorRoot" component={VendorRoot} />
    </Stack.Navigator>
  );
}
