import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { View, ScrollView, TextInput, Alert, Switch, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, Skeleton, Image, Badge, elevation, PressableScale, EmptyState, ChoiceChip, Input, SettingsGroup, SettingsRow } from '../../components/ui';
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
  useAddOptionGroup,
  useDeleteOptionGroup,
  useAddOption,
  useDeleteOption,
  useVendorSubscription,
  useVendorAnalytics,
  useVendorRevenue,
  usePopularItems,
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

const TYPES = [
  { key: 'RESTAURANT', label: 'Restaurant', icon: 'silverware-fork-knife' },
  { key: 'SUPERMARKET', label: 'Grocery', icon: 'basket-outline' },
  { key: 'STORE', label: 'Shop', icon: 'storefront-outline' },
  { key: 'SERVICE', label: 'Services', icon: 'tools' },
] as const;

function BizValuePill({ icon, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string }) {
  return (
    <View className="flex-row items-center rounded-full bg-brand-50 px-3 py-1.5">
      <MaterialCommunityIcons name={icon} size={14} color={color.brand[600]} />
      <Text className="ml-1.5 text-xs font-bold text-brand-700">{label}</Text>
    </View>
  );
}

function BizTypeTile({ t, active, onPress }: { t: (typeof TYPES)[number]; active: boolean; onPress: () => void }) {
  return (
    <PressableScale onPress={onPress} style={{ flex: 1 }}>
      <View
        className={
          active
            ? 'items-center rounded-2xl border-2 border-brand-500 bg-brand-50 py-md'
            : 'items-center rounded-2xl border border-border-subtle bg-surface-base py-md'
        }
      >
        <View
          className="mb-1 h-10 w-10 items-center justify-center rounded-full"
          style={{ backgroundColor: active ? color.brand[500] : color.surface.subtle }}
        >
          <MaterialCommunityIcons name={t.icon} size={20} color={active ? '#fff' : color.text.secondary} />
        </View>
        <Text className={active ? 'text-xs font-bold text-brand-700' : 'text-xs font-bold text-text-primary'} numberOfLines={1}>
          {t.label}
        </Text>
      </View>
    </PressableScale>
  );
}

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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <Header title="Sell on Swift" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Heading size="2xl">List your business</Heading>
        <Text className="mt-xs text-[15px] leading-5 text-text-secondary">
          Reach customers across town and keep 100% of every sale — Swift charges a flat weekly fee, never commission.
        </Text>
        <View className="mb-md mt-md flex-row flex-wrap" style={{ gap: 8 }}>
          <BizValuePill icon="check-decagram" label="Keep 100%" />
          <BizValuePill icon="cash-remove" label="No commission" />
          <BizValuePill icon="calendar-check" label="Flat weekly fee" />
        </View>

        <Text className="mb-sm mt-sm text-sm font-bold text-text-primary">Business type</Text>
        <View className="flex-row" style={{ gap: 8 }}>
          {TYPES.map((t) => (
            <BizTypeTile key={t.key} t={t} active={t.key === type} onPress={() => setType(t.key)} />
          ))}
        </View>

        <View className="mt-lg rounded-3xl bg-surface-base p-lg" style={elevation.card}>
          <View className="gap-sm">
            <Input value={name} onChangeText={setName} placeholder="Business name" />
            <Input value={phone} onChangeText={setPhone} placeholder="Business phone" keyboardType="phone-pad" />
            <Input value={addr} onChangeText={setAddr} placeholder="Street address" />
            <Input value={city} onChangeText={setCity} placeholder="City" />
          </View>
          <Text className="mt-sm text-xs text-text-muted">We&apos;ll use your current location as the store pin.</Text>
        </View>

        {become.isError ? <Text className="mb-sm mt-sm text-sm text-error">Couldn&apos;t create your store. Try again.</Text> : null}
        <Button label="Create store" loading={become.isPending} disabled={!valid} className="mt-md" onPress={submit} />
      </ScrollView>
    </SafeAreaView>
  );
}

function VendorOnboarding({ store }: { store: any }) {
  const { data: status, isLoading, isError, refetch } = useVerificationStatus<any>(store.vendorType);
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <Header title={store.name} />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <DocumentChecklist
          role={store.vendorType}
          status={status}
          isLoading={isLoading}
          isError={isError}
          onRetry={refetch}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

type VendorOrderActionKind = 'accept' | 'preparing' | 'ready' | 'reject' | 'complete-pickup' | 'complete-appointment';

function orderActions(order: any): { label: string; action: VendorOrderActionKind }[] {
  const s = (order?.status || '').toUpperCase();
  const isPickup = order?.fulfillment === 'PICKUP';
  const isAppt = order?.fulfillment === 'APPOINTMENT';
  if (s === 'PENDING' || s === 'PLACED')
    return [{ label: 'Accept', action: 'accept' }, { label: isAppt ? 'Decline' : 'Reject', action: 'reject' }];
  // Appointments skip prepare/ready — accepting books the slot, then the vendor marks it done.
  if (isAppt && (s === 'ACCEPTED' || s === 'CONFIRMED')) return [{ label: 'Mark complete', action: 'complete-appointment' }];
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

// Appointment slot → "Mon 14 Jul · 2:30 PM" (manual format; Hermes Intl is limited).
function formatSlot(iso?: string) {
  if (!iso) return 'Time to be confirmed';
  const d = new Date(iso);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} · ${h}:${String(m).padStart(2, '0')} ${ampm}`;
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
  showStore,
}: {
  order: any;
  onAction: (action: VendorOrderActionKind) => void;
  busy: boolean;
  showStore?: boolean;
}) {
  const actions = orderActions(order);
  const items = order.itemCount ?? order.items?.length ?? 0;
  const isPickup = order.fulfillment === 'PICKUP';
  const isAppt = order.fulfillment === 'APPOINTMENT';
  // A mobile service stores the customer's address (≠ the store's pickup address).
  const apptMobile = isAppt && !!order.deliveryAddress && order.deliveryAddress !== order.pickupAddress;
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
          ) : isAppt ? (
            <View className="flex-row items-center rounded-full bg-surface-subtle px-2 py-0.5">
              <MaterialCommunityIcons name="calendar-clock" size={12} color={color.brand[500]} />
              <Text className="ml-1 text-xs font-semibold text-brand-600">Appointment</Text>
            </View>
          ) : null}
        </View>
        <StatusPill status={order.status} />
      </View>
      {showStore && order.vendor?.name ? (
        <View className="mt-xs flex-row items-center">
          <MaterialCommunityIcons name="storefront-outline" size={12} color={color.brand[500]} />
          <Text className="ml-1 text-xs font-bold text-brand-600" numberOfLines={1}>{order.vendor.name}</Text>
        </View>
      ) : null}
      <View className="mt-xs flex-row items-center">
        <Feather name="clock" size={13} color={color.text.muted} />
        <Text className="ml-1 text-xs text-text-muted">{timeAgo(order.placedAt)}</Text>
        {items ? <Text className="ml-2 text-xs text-text-muted">{`· ${items} item${items === 1 ? '' : 's'}`}</Text> : null}
        <Text className="ml-2 text-xs text-text-muted">{`· ${order.paymentMethod === 'CASH' ? 'Cash' : order.paymentMethod ?? ''}`}</Text>
      </View>
      {isAppt ? (
        <View className="mt-sm">
          <View className="flex-row items-center">
            <MaterialCommunityIcons name="calendar-clock" size={14} color={color.brand[500]} />
            <Text className="ml-1 text-sm font-bold text-text-primary">{formatSlot(order.appointmentSlot)}</Text>
          </View>
          <View className="mt-xs flex-row items-center">
            <Feather name={apptMobile ? 'navigation' : 'home'} size={12} color={color.text.muted} />
            <Text className="ml-1 flex-1 text-xs text-text-secondary" numberOfLines={1}>
              {apptMobile ? `You travel to: ${order.deliveryAddress}` : 'At your store'}
            </Text>
          </View>
        </View>
      ) : isPickup && order.pickupCode ? (
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
  const analyticsQ = useVendorAnalytics();
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
  const today: any = (analyticsQ.data as any)?.today ?? {};

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
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

        {/* Today's sales — Eats-Manager hero */}
        <View className="mb-md rounded-3xl bg-surface-base p-lg" style={CARD_SHADOW}>
          <Text className="text-[11px] font-bold uppercase tracking-[1.5px] text-text-muted">Today&apos;s sales</Text>
          <Text className="mt-0.5 font-display text-3xl font-extrabold text-text-primary">{money(today.revenue ?? 0)}</Text>
          <View className="mt-1 flex-row items-center">
            <MaterialCommunityIcons name="check-decagram" size={14} color={color.success} />
            <Text className="ml-1 text-xs font-semibold text-text-secondary">
              100% yours · {today.orders ?? 0} order{(today.orders ?? 0) === 1 ? '' : 's'} today
            </Text>
          </View>
        </View>

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

        {/* The Swift model — you keep everything */}
        <View className="mb-md flex-row items-center rounded-2xl bg-surface-subtle px-md py-sm">
          <MaterialCommunityIcons name="check-decagram" size={15} color={color.success} />
          <Text className="ml-2 flex-1 text-xs font-semibold text-text-secondary">
            You keep 100% of every sale — Swift charges a flat weekly fee, never commission.
          </Text>
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
            <VendorOrderCard key={o.id} order={o} busy={busy} showStore={stores.length > 1} onAction={(action) => orderAction.mutate({ id: o.id, action })} />
          ))
        )}

        {/* In progress */}
        {inProgress.length > 0 ? (
          <>
            <Heading size="lg" className="mb-sm mt-md">In progress</Heading>
            {inProgress.map((o) => (
              <VendorOrderCard key={o.id} order={o} busy={busy} showStore={stores.length > 1} onAction={(action) => orderAction.mutate({ id: o.id, action })} />
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
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
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
          {item.stockQuantity != null && item.stockQuantity <= 0 ? (
            <Text className="mt-0.5 text-xs font-semibold text-error">Out of stock — hidden from customers</Text>
          ) : item.stockQuantity != null && item.lowStockThreshold != null && item.stockQuantity <= item.lowStockThreshold ? (
            <Text className="mt-0.5 text-xs font-semibold text-warning">Low stock — restock soon</Text>
          ) : null}
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

/**
 * Modifiers editor (master plan §4.2): size / add-ons / toppings on an item.
 * The OptionGroup CRUD already exists server-side — this is its operator UI.
 * Mutations resolve to the created row, so the list updates from the response
 * instead of waiting on the menu query.
 */
function ModifiersSection({ item }: { item: any }) {
  const [groups, setGroups] = useState<any[]>(item.optionGroups ?? []);
  const addGroup = useAddOptionGroup();
  const delGroup = useDeleteOptionGroup();
  const addOption = useAddOption();
  const delOption = useDeleteOption();

  const [groupName, setGroupName] = useState('');
  const [groupRequired, setGroupRequired] = useState(false);
  const [groupMulti, setGroupMulti] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { name: string; price: string }>>({});
  const draft = (gid: string) => drafts[gid] ?? { name: '', price: '' };

  const submitGroup = async () => {
    const name = groupName.trim();
    if (!name || addGroup.isPending) return;
    const g = await addGroup.mutateAsync({
      itemId: item.id,
      data: { name, isRequired: groupRequired, minSelect: groupRequired ? 1 : 0, maxSelect: groupMulti ? 10 : 1 },
    });
    setGroups((gs) => [...gs, { options: [], ...g }]);
    setGroupName('');
    setGroupRequired(false);
    setGroupMulti(false);
  };

  const submitOption = async (groupId: string) => {
    const d = draft(groupId);
    const name = d.name.trim();
    if (!name || addOption.isPending) return;
    const opt = await addOption.mutateAsync({
      groupId,
      data: { name, additionalPrice: Number(d.price) || 0 },
    });
    setGroups((gs) => gs.map((g) => (g.id === groupId ? { ...g, options: [...(g.options ?? []), opt] } : g)));
    setDrafts((s) => ({ ...s, [groupId]: { name: '', price: '' } }));
  };

  const removeGroup = (groupId: string) => {
    Alert.alert('Remove group', 'Delete this option group and all its choices?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          delGroup.mutate(groupId, { onSuccess: () => setGroups((gs) => gs.filter((g) => g.id !== groupId)) }),
      },
    ]);
  };

  const removeOption = (groupId: string, optionId: string) => {
    delOption.mutate(optionId, {
      onSuccess: () =>
        setGroups((gs) =>
          gs.map((g) => (g.id === groupId ? { ...g, options: (g.options ?? []).filter((o: any) => o.id !== optionId) } : g)),
        ),
    });
  };

  return (
    <View className="mt-md rounded-3xl bg-surface-base p-lg" style={CARD_SHADOW}>
      <Heading size="lg">Options &amp; add-ons</Heading>
      <Text className="mt-xs text-sm text-text-secondary">
        Sizes, toppings, extras — customers pick these when ordering.
      </Text>

      {groups.map((g) => (
        <View key={g.id} className="mt-md rounded-2xl bg-surface-subtle p-md">
          <View className="flex-row items-center">
            <View className="flex-1">
              <Text className="text-base font-semibold">{g.name}</Text>
              <Text className="mt-0.5 text-xs text-text-muted">
                {g.isRequired ? 'Required' : 'Optional'} · {g.maxSelect > 1 ? `up to ${g.maxSelect}` : 'pick one'}
              </Text>
            </View>
            <PressableScale onPress={() => removeGroup(g.id)} hitSlop={8}>
              <Feather name="trash-2" size={18} color={color.text.muted} />
            </PressableScale>
          </View>

          {(g.options ?? []).map((o: any) => (
            <View key={o.id} className="mt-sm flex-row items-center">
              <Text className="flex-1 text-sm text-text-primary">{o.name}</Text>
              <Text className="mr-md text-sm text-text-secondary">
                {Number(o.additionalPrice) > 0 ? `+${money(o.additionalPrice)}` : 'Free'}
              </Text>
              <PressableScale onPress={() => removeOption(g.id, o.id)} hitSlop={8}>
                <Feather name="x" size={16} color={color.text.muted} />
              </PressableScale>
            </View>
          ))}

          <View className="mt-sm flex-row items-center" style={{ gap: 8 }}>
            <Input
              containerClassName="flex-1"
              value={draft(g.id).name}
              onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), name: t } }))}
              placeholder="Choice (e.g. Large)"
            />
            <Input
              containerClassName="w-24"
              value={draft(g.id).price}
              onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), price: t } }))}
              placeholder="+GYD"
              keyboardType="number-pad"
            />
            <PressableScale
              onPress={() => submitOption(g.id)}
              disabled={addOption.isPending}
              className="h-10 w-10 items-center justify-center rounded-full bg-brand-500"
            >
              <Feather name="plus" size={18} color="#fff" />
            </PressableScale>
          </View>
        </View>
      ))}

      <View className="mt-md">
        <Input value={groupName} onChangeText={setGroupName} placeholder="New group (e.g. Size, Toppings)" />
        <View className="mt-sm flex-row" style={{ gap: 8 }}>
          <ChoiceChip label="Required" active={groupRequired} onPress={() => setGroupRequired((v) => !v)} />
          <ChoiceChip label="Multiple picks" active={groupMulti} onPress={() => setGroupMulti((v) => !v)} />
        </View>
        <Button
          label="Add option group"
          variant="outline"
          className="mt-sm"
          loading={addGroup.isPending}
          disabled={!groupName.trim()}
          onPress={submitGroup}
        />
      </View>
    </View>
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
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
              <Input containerClassName="flex-1" value={newCat} onChangeText={setNewCat} placeholder="e.g. Mains, Drinks" />
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
  const [lowStock, setLowStock] = useState<string>(existing?.lowStockThreshold != null ? String(existing.lowStockThreshold) : '');
  const [localPhoto, setLocalPhoto] = useState<{ uri: string; name: string; type: string } | null>(null);

  // Service businesses configure a bookable appointment instead of stock.
  const { store } = useVendorProfile();
  const isService = store?.vendorType === 'SERVICE';
  const existingBooking = (existing?.bookingConfig ?? {}) as any;
  const [duration, setDuration] = useState<number>(existingBooking.durationMinutes ?? 30);
  const [days, setDays] = useState<number[]>(() => {
    const ds: number[] = (existingBooking.slots ?? []).map((s: any) => s.dayOfWeek);
    return ds.length ? Array.from(new Set(ds)) : [1, 2, 3, 4, 5];
  });
  const [startTime, setStartTime] = useState<string>(existingBooking.slots?.[0]?.start ?? '09:00');
  const [endTime, setEndTime] = useState<string>(existingBooking.slots?.[0]?.end ?? '17:00');
  const [mode, setMode] = useState<'AT_BUSINESS' | 'MOBILE' | 'BOTH'>(existingBooking.serviceMode ?? 'AT_BUSINESS');
  const [radius, setRadius] = useState<string>(existingBooking.serviceRadiusKm != null ? String(existingBooking.serviceRadiusKm) : '5');

  const priceNum = Number(price);
  const valid =
    name.trim().length >= 1 && Number.isFinite(priceNum) && priceNum >= 0 && !!categoryId && (!isService || days.length > 0);
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
    const bookingConfig = isService
      ? {
          durationMinutes: duration,
          slots: days.map((d) => ({ dayOfWeek: d, start: startTime, end: endTime })),
          serviceMode: mode,
          ...(mode !== 'AT_BUSINESS' ? { serviceRadiusKm: Number(radius) || 0 } : {}),
        }
      : undefined;
    const saved: any = await save.mutateAsync({
      id: existing?.id,
      data: {
        categoryId,
        name: name.trim(),
        description: description.trim() || undefined,
        basePrice: priceNum,
        isAvailable: available,
        isPopular: popular,
        ...(isService
          ? { fulfillment: 'APPOINTMENT' as const, bookingConfig }
          : {
              sku: sku.trim() || undefined,
              unit: unit.trim() || undefined,
              // '' clears tracking (null) so a vendor can stop tracking stock.
              stockQuantity: stock.trim() === '' ? null : Number.isFinite(stockNum as number) ? stockNum : undefined,
              lowStockThreshold: lowStock.trim() === '' ? null : Number(lowStock) >= 0 ? Number(lowStock) : undefined,
            }),
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
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

        <View className="gap-sm">
          <Input value={name} onChangeText={setName} placeholder="Item name" />
          <Input value={price} onChangeText={setPrice} placeholder="Price (GYD)" keyboardType="decimal-pad" />
          <Input value={description} onChangeText={setDescription} placeholder="Description (optional)" multiline />
        </View>

        {isService ? (
          <View className="mt-md rounded-3xl bg-surface-base p-lg" style={CARD_SHADOW}>
            <Heading size="lg" className="mb-sm">Appointment booking</Heading>

            <Text className="mb-xs text-xs font-semibold text-text-muted">Appointment length</Text>
            <View className="mb-md flex-row flex-wrap" style={{ gap: 8 }}>
              {[15, 30, 45, 60, 90, 120].map((m) => (
                <ChoiceChip key={m} label={`${m} min`} active={duration === m} onPress={() => setDuration(m)} />
              ))}
            </View>

            <Text className="mb-xs text-xs font-semibold text-text-muted">Available days</Text>
            <View className="mb-md flex-row flex-wrap" style={{ gap: 6 }}>
              {DAY_LABELS.map((d, i) => {
                const on = days.includes(i);
                return (
                  <PressableScale
                    key={i}
                    onPress={() => setDays((p) => (on ? p.filter((x) => x !== i) : [...p, i]))}
                    className={on ? 'rounded-full bg-brand-500 px-md py-sm' : 'rounded-full border border-border-subtle bg-surface-subtle px-md py-sm'}
                  >
                    <Text className={on ? 'text-xs font-bold text-white' : 'text-xs font-bold text-text-secondary'}>{d}</Text>
                  </PressableScale>
                );
              })}
            </View>

            <Text className="mb-xs text-xs font-semibold text-text-muted">Hours</Text>
            <View className="mb-md flex-row items-center" style={{ gap: 8 }}>
              <Input containerClassName="flex-1" value={startTime} onChangeText={setStartTime} placeholder="09:00" />
              <Text className="text-text-muted">to</Text>
              <Input containerClassName="flex-1" value={endTime} onChangeText={setEndTime} placeholder="17:00" />
            </View>

            <Text className="mb-xs text-xs font-semibold text-text-muted">Where does it happen?</Text>
            <View className="mb-md flex-row flex-wrap" style={{ gap: 8 }}>
              <ChoiceChip label="At my place" active={mode === 'AT_BUSINESS'} onPress={() => setMode('AT_BUSINESS')} />
              <ChoiceChip label="I travel to them" active={mode === 'MOBILE'} onPress={() => setMode('MOBILE')} />
              <ChoiceChip label="Both" active={mode === 'BOTH'} onPress={() => setMode('BOTH')} />
            </View>

            {mode !== 'AT_BUSINESS' ? (
              <View>
                <Text className="mb-xs text-xs font-semibold text-text-muted">How far will you travel from your store? (km)</Text>
                <Input value={radius} onChangeText={setRadius} placeholder="5" keyboardType="number-pad" />
              </View>
            ) : null}
          </View>
        ) : (
          <>
            {/* Inventory — used by groceries/shops; optional for restaurants */}
            <Text className="mb-xs mt-sm text-sm font-semibold text-text-secondary">Inventory (optional)</Text>
            <View className="gap-sm">
              <View className="flex-row" style={{ gap: 8 }}>
                <Input containerClassName="flex-1" value={stock} onChangeText={setStock} placeholder="Stock qty" keyboardType="number-pad" />
                <Input containerClassName="flex-1" value={unit} onChangeText={setUnit} placeholder="Unit (kg, ea)" />
              </View>
              <Input value={sku} onChangeText={setSku} placeholder="SKU / barcode (optional)" />
              <Input value={lowStock} onChangeText={setLowStock} placeholder="Low-stock alert at (e.g. 5)" keyboardType="number-pad" />
              {stock.trim() !== '' ? (
                <Text className="text-xs text-text-muted">
                  Tracked items sell down automatically and hide at 0. You’ll get an alert at your low-stock level.
                </Text>
              ) : null}
            </View>
          </>
        )}

        {existing && !isService ? (
          <ModifiersSection item={existing} />
        ) : !isService ? (
          <Text className="mt-sm text-xs text-text-muted">
            Save the item first to add options &amp; add-ons (sizes, toppings, extras).
          </Text>
        ) : null}

        <Text className="mb-xs mt-sm text-sm font-semibold text-text-secondary">Category</Text>
        <View className="mb-md flex-row flex-wrap" style={{ gap: 8 }}>
          {categories.map((c) => (
            <ChoiceChip key={c.id} label={c.name} active={c.id === categoryId} onPress={() => setCategoryId(c.id)} />
          ))}
        </View>

        <View className="mb-md flex-row" style={{ gap: 8 }}>
          <ChoiceChip label={available ? 'Available' : 'Sold out'} active={available} onPress={() => setAvailable((v) => !v)} />
          <ChoiceChip label="★ Popular" active={popular} onPress={() => setPopular((v) => !v)} />
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
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }
  return <VendorOps store={store} navigation={navigation} />;
}

/**
 * Owned bar chart (no chart dependency): daily revenue, bars scaled to the
 * period max. Endpoint pre-fills gap days with zero so the series is dense.
 */
function RevenueChart({ daily, totals }: { daily: Array<{ date: string; revenue: number }>; totals: { revenue: number; orders: number } }) {
  const CHART_HEIGHT = 96;
  const max = Math.max(...daily.map((d) => d.revenue), 1);
  const dayLabel = (iso: string) => {
    const d = new Date(`${iso}T12:00:00Z`);
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  };
  return (
    <Card className="mb-md">
      <View className="flex-row items-baseline justify-between">
        <Text className="text-base font-semibold">Last {daily.length} days</Text>
        <Text className="text-sm text-text-secondary">
          {money(totals.revenue)} · {totals.orders} orders
        </Text>
      </View>
      {totals.orders === 0 ? (
        <Text className="mt-md text-sm text-text-muted">No completed orders yet — sales will chart here.</Text>
      ) : (
        <>
          <View className="mt-md flex-row items-end" style={{ height: CHART_HEIGHT, gap: 3 }}>
            {daily.map((d) => (
              <View
                key={d.date}
                className={d.revenue > 0 ? 'flex-1 rounded-t-sm bg-brand-500' : 'flex-1 rounded-t-sm bg-surface-subtle'}
                style={{ height: Math.max(3, Math.round((d.revenue / max) * CHART_HEIGHT)) }}
              />
            ))}
          </View>
          <View className="mt-xs flex-row justify-between">
            <Text className="text-xs text-text-muted">{dayLabel(daily[0]!.date)}</Text>
            <Text className="text-xs text-text-muted">peak {money(max)}</Text>
            <Text className="text-xs text-text-muted">{dayLabel(daily[daily.length - 1]!.date)}</Text>
          </View>
        </>
      )}
    </Card>
  );
}

function TopItemsCard({ items }: { items: any[] }) {
  const ranked = items.filter((i) => i.totalOrdered > 0 || i.recentOrders > 0);
  return (
    <Card className="mb-md">
      <Text className="text-base font-semibold">Top items</Text>
      {ranked.length === 0 ? (
        <Text className="mt-sm text-sm text-text-muted">Your best sellers will rank here once orders come in.</Text>
      ) : (
        ranked.map((item, i) => (
          <View key={item.id} className="mt-sm flex-row items-center">
            <Text className="w-6 text-sm font-bold text-text-muted">{i + 1}</Text>
            {item.imageUrl ? (
              <Image source={{ uri: mediaUrl(item.imageUrl)! }} style={{ width: 34, height: 34, borderRadius: 8 }} />
            ) : (
              <View style={{ width: 34, height: 34, borderRadius: 8 }} className="items-center justify-center bg-surface-subtle">
                <Feather name="image" size={14} color={color.text.muted} />
              </View>
            )}
            <View className="ml-sm flex-1">
              <Text className="text-sm font-semibold" numberOfLines={1}>{item.name}</Text>
              <Text className="text-xs text-text-muted">{item.category?.name ?? ''}</Text>
            </View>
            <View className="items-end">
              <Text className="text-sm font-semibold">{item.recentOrders} this month</Text>
              <Text className="text-xs text-text-muted">{item.totalOrdered} all time</Text>
            </View>
          </View>
        ))
      )}
    </Card>
  );
}

function VendorInsightsScreen() {
  const q = useVendorAnalytics();
  const revenueQ = useVendorRevenue(14);
  const popularQ = usePopularItems(8);
  const a: any = q.data ?? {};
  const v: any = a.vendor ?? {};
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <Header title="Insights" />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); revenueQ.refetch(); popularQ.refetch(); }} tintColor={color.brand[500]} />}
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
            {revenueQ.isLoading ? (
              <Skeleton className="mb-md h-40 w-full rounded-2xl" />
            ) : revenueQ.data?.daily?.length ? (
              <RevenueChart daily={revenueQ.data.daily} totals={revenueQ.data.totals} />
            ) : null}
            {popularQ.isLoading ? (
              <Skeleton className="mb-md h-32 w-full rounded-2xl" />
            ) : popularQ.data ? (
              <TopItemsCard items={popularQ.data} />
            ) : null}
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <Header title="Account" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <SettingsGroup>
          <View className="flex-row items-center px-md py-md">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-brand-500">
              <MaterialCommunityIcons name="storefront" size={26} color="#fff" />
            </View>
            <View className="ml-md flex-1">
              <Text className="text-lg font-bold text-text-primary" numberOfLines={1}>{store?.name ?? 'Your store'}</Text>
              <Text className="mt-0.5 text-sm text-text-secondary" numberOfLines={1}>
                {prettyVendorType(store?.vendorType)}{store?.city ? ` · ${store.city}` : ''}
              </Text>
            </View>
          </View>
        </SettingsGroup>

        <SettingsGroup header="Plan">
          <SettingsRow
            icon="cash-multiple"
            label="Subscription"
            sublabel={sub.data ? 'Active weekly plan' : 'Not active yet'}
            right={<Badge label={sub.data ? 'Active' : 'Inactive'} tone={sub.data ? 'success' : 'brand'} />}
          />
          {store?.phone ? <SettingsRow icon="phone-outline" label="Phone" value={store.phone} /> : null}
        </SettingsGroup>

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
