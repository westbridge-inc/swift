/** @jsxImportSource react */
import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pressable, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { SvgXml } from 'react-native-svg';
import {
  Card,
  Chip,
  EmptyState,
  IconChip,
  LabeledInput,
  LinkText,
  LoadingBlock,
  PillButton,
  PopupCard,
  Screen,
  SettingsRow,
  T,
  TonePill,
} from '../../kit';
import { BrandSwitch } from '../../kit/controls';
import {
  DAY_LABELS,
  DeltaBadge,
  FulfillmentTag,
  GUTTER,
  InlineInput,
  KpiTile,
  OrderStatusPill,
  SubHeader,
  fmtDate,
  fmtWhen,
  formatSlot,
  orderActions,
  prettyVendorType,
  type VendorOrderActionKind,
} from './shared';
import { VendorOrderDetailScreen } from './screens/VendorOrderDetailScreen';
import { VendorOrderHistoryScreen } from './screens/VendorOrderHistoryScreen';
import { DocumentChecklist } from '../../components/onboarding/DocumentChecklist';
import { useBecomePartner, useVerificationStatus } from '../../hooks/verification';
import {
  useVendorProfile,
  useVendorOrders,
  useVendorOrdersLive,
  useToggleOpen,
  useToggleOrders,
  useOrderAction,
  useVendorMenu,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useVendorQr,
  useSaveItem,
  useDeleteItem,
  useSetItemAvailability,
  useUploadItemImage,
  useAddOptionGroup,
  useDeleteOptionGroup,
  useAddOption,
  useDeleteOption,
  useVendorStaff,
  useAddStaff,
  useRemoveStaff,
  useUpdateStaffRole,
  useVendorPromos,
  useCreatePromo,
  useUpdatePromo,
  useDeletePromo,
  useMyStoreReviews,
  useRespondReview,
  useVendorSubscription,
  useVendorAnalytics,
  useVendorRevenue,
  useVendorOps,
  usePopularItems,
  useBusyHours,
  useVendorHours,
  useSetHours,
  type DayHours,
} from '../../hooks/vendorops';
import { useAuthStore } from '../../stores/authStore';
import { track } from '../../lib/analytics';
import { useLocationStore } from '../../stores/locationStore';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { RoleSwitcherSheet } from '../../components/RoleSwitcherSheet';
import { money } from '../../lib/money';
import { mediaUrl } from '../../lib/images';
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
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 9999,
        paddingHorizontal: space.md,
        paddingVertical: 6,
        backgroundColor: color.brand[50],
      }}
    >
      <MaterialCommunityIcons name={icon} size={14} color={color.brand[600]} />
      <T variant="caption" weight="bold" tone="deep">
        {label}
      </T>
    </View>
  );
}

function BizTypeTile({ t, active, onPress }: { t: (typeof TYPES)[number]; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1 }}>
      {({ pressed }) => (
        <View
          style={{
            alignItems: 'center',
            borderRadius: radius.lg,
            borderWidth: 1,
            paddingVertical: space.md,
            borderColor: active ? color.brand[500] : color.border.subtle,
            backgroundColor: active ? color.brand[50] : color.surface.base,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 4,
              backgroundColor: active ? color.brand[500] : color.brand[50],
            }}
          >
            <MaterialCommunityIcons name={t.icon} size={20} color={active ? color.white : color.brand[600]} />
          </View>
          <T variant="caption" weight="bold" tone={active ? 'deep' : 'ink'} numberOfLines={1}>
            {t.label}
          </T>
        </View>
      )}
    </Pressable>
  );
}

/** Tab-root header: title left, Log out link right (kit language). */
function TabHeader({ title, onSwitch }: { title: string; onSwitch?: () => void }) {
  const { logout } = useAuthStore();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: GUTTER,
        height: 56,
      }}
    >
      <View style={{ flex: 1, paddingRight: space.md }}>
        <T variant="caption" weight="bold" tone="brand" style={{ letterSpacing: 1.5 }}>
          SWIFT BUSINESS
        </T>
        <T variant="title" numberOfLines={1}>
          {title}
        </T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
        {onSwitch ? <LinkText label="Switch app" onPress={onSwitch} /> : null}
        <LinkText label="Log out" tone="muted" onPress={logout} />
      </View>
    </View>
  );
}

function BusinessSetup() {
  const become = useBecomePartner();
  const [switcherOpen, setSwitcherOpen] = useState(false);
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
    <Screen>
      <TabHeader title="Sell on Swift" onSwitch={() => setSwitcherOpen(true)} />
      <RoleSwitcherSheet visible={switcherOpen} current="vendor" onClose={() => setSwitcherOpen(false)} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        <T variant="title">List your business</T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
          Reach customers across town and keep 100% of every sale — Swift charges a flat weekly fee, never commission.
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.lg, marginBottom: space.lg }}>
          <BizValuePill icon="check-decagram" label="Keep 100%" />
          <BizValuePill icon="cash-remove" label="No commission" />
          <BizValuePill icon="calendar-check" label="Flat weekly fee" />
        </View>

        <T variant="heading" style={{ marginBottom: space.md }}>
          Business type
        </T>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          {TYPES.map((t) => (
            <BizTypeTile key={t.key} t={t} active={t.key === type} onPress={() => setType(t.key)} />
          ))}
        </View>

        <Card style={{ marginTop: space.xl, gap: space.md }}>
          <LabeledInput value={name} onChangeText={setName} placeholder="Business name" />
          <LabeledInput value={phone} onChangeText={setPhone} placeholder="Business phone" keyboardType="phone-pad" />
          <LabeledInput value={addr} onChangeText={setAddr} placeholder="Street address" />
          <LabeledInput value={city} onChangeText={setCity} placeholder="City" />
          <T variant="caption" tone="muted">
            We&apos;ll use your current location as the store pin.
          </T>
        </Card>

        {become.isError ? (
          <T variant="label" tone="error" style={{ marginTop: space.md }}>
            Couldn&apos;t create your store. Try again.
          </T>
        ) : null}
        <PillButton label="Create store" loading={become.isPending} disabled={!valid} style={{ marginTop: space.lg }} onPress={submit} />
      </ScrollView>
    </Screen>
  );
}

function VendorOnboarding({ store }: { store: any }) {
  const { data: status, isLoading, isError, refetch } = useVerificationStatus<any>(store.vendorType);
  return (
    <Screen>
      <TabHeader title={store.name} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        <DocumentChecklist role={store.vendorType} status={status} isLoading={isLoading} isError={isError} onRetry={refetch} />
      </ScrollView>
    </Screen>
  );
}

function VendorOrderCard({
  order,
  onAction,
  onOpen,
  busy,
  showStore,
}: {
  order: any;
  onAction: (action: VendorOrderActionKind) => void;
  onOpen?: () => void;
  busy: boolean;
  showStore?: boolean;
}) {
  const actions = orderActions(order);
  const items = order.itemCount ?? order.items?.length ?? 0;
  const lines: any[] = order.items ?? [];
  const isPickup = order.fulfillment === 'PICKUP';
  const isAppt = order.fulfillment === 'APPOINTMENT';
  // A mobile service stores the customer's address (≠ the store's pickup address).
  const apptMobile = isAppt && !!order.deliveryAddress && order.deliveryAddress !== order.pickupAddress;
  return (
    <Pressable onPress={onOpen} disabled={!onOpen}>
      {({ pressed }) => (
    <Card style={{ marginBottom: space.md, opacity: pressed && onOpen ? 0.88 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <T variant="body" weight="bold">
            {order.orderNumber ? `#${order.orderNumber}` : 'Order'}
          </T>
          {isPickup ? (
            <FulfillmentTag icon="bag-personal-outline" label="Takeaway" />
          ) : isAppt ? (
            <FulfillmentTag icon="calendar-clock" label="Appointment" />
          ) : order.isExpress ? (
            <FulfillmentTag icon="lightning-bolt" label="Express" />
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <OrderStatusPill status={order.status} />
          {onOpen ? <Feather name="chevron-right" size={16} color={color.text.muted} /> : null}
        </View>
      </View>
      {showStore && order.vendor?.name ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <MaterialCommunityIcons name="storefront-outline" size={12} color={color.brand[500]} />
          <T variant="caption" weight="bold" tone="brand" numberOfLines={1}>
            {order.vendor.name}
          </T>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 4 }}>
        <Feather name="clock" size={13} color={color.text.muted} />
        <T variant="caption" tone="muted">
          {fmtWhen(order.placedAt)}
          {items ? ` · ${items} item${items === 1 ? '' : 's'}` : ''}
          {` · ${order.paymentMethod === 'CASH' ? 'Cash' : order.paymentMethod ?? ''}`}
        </T>
      </View>
      {/* What to make — the kitchen reads this off the card */}
      {lines.length > 0 ? (
        <View style={{ marginTop: space.sm, borderRadius: radius.md, backgroundColor: color.surface.subtle, paddingHorizontal: space.md, paddingVertical: space.sm }}>
          {lines.slice(0, 3).map((it: any) => (
            <View key={it.id} style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <T variant="label" weight="bold" tone="brand" style={{ width: 30 }}>
                {it.quantity}×
              </T>
              <T variant="label" numberOfLines={1} style={{ flex: 1 }}>
                {it.name}
              </T>
            </View>
          ))}
          {lines.length > 3 ? (
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              +{lines.length - 3} more — tap for the full order
            </T>
          ) : null}
        </View>
      ) : null}
      {isAppt ? (
        <View style={{ marginTop: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <MaterialCommunityIcons name="calendar-clock" size={14} color={color.brand[500]} />
            <T variant="label" weight="bold">
              {formatSlot(order.appointmentSlot)}
            </T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <Feather name={apptMobile ? 'navigation' : 'home'} size={12} color={color.text.muted} />
            <T variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
              {apptMobile ? `You travel to: ${order.deliveryAddress}` : 'At your store'}
            </T>
          </View>
        </View>
      ) : isPickup && order.pickupCode ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.sm }}>
          <MaterialCommunityIcons name="form-textbox-password" size={13} color={color.text.muted} />
          <T variant="label" tone="muted">
            Pickup code{' '}
          </T>
          <T variant="label" weight="bold" tone="brand">
            {order.pickupCode}
          </T>
        </View>
      ) : !isPickup && order.deliveryAddress ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.sm }}>
          <Feather name="map-pin" size={13} color={color.text.muted} />
          <T variant="label" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
            {order.deliveryAddress}
          </T>
        </View>
      ) : null}
      <T variant="heading" style={{ marginTop: space.sm }}>
        {money(order.totalAmount ?? order.total)}
      </T>
      {actions.length > 0 ? (
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          {actions.map((a) => (
            <PillButton
              key={a.action}
              label={a.label}
              variant={a.action === 'reject' ? 'outline' : 'primary'}
              size="md"
              style={{ flex: 1 }}
              disabled={busy}
              onPress={() => onAction(a.action)}
            />
          ))}
        </View>
      ) : null}
    </Card>
      )}
    </Pressable>
  );
}

function VendorOps({ store, navigation }: any) {
  const toggleOpen = useToggleOpen();
  const toggleOrders = useToggleOrders();
  const orderAction = useOrderAction();
  const ordersQ = useVendorOrders(true);
  const analyticsQ = useVendorAnalytics();
  const { stores, myRole } = useVendorProfile();
  const setSelectedStore = useStoreSwitcher((s) => s.setSelectedStore);
  const qc = useQueryClient();
  const switchStore = (id: string) => {
    setSelectedStore(id);
    qc.invalidateQueries({ queryKey: ['vendor'] });
  };
  const fetched: any[] = ordersQ.data ?? [];
  const open = !!store.isCurrentlyOpen;
  const accepting = !!store.acceptingOrders;
  const busy = orderAction.isPending;

  // The live board works the open queue; finished orders live in History.
  const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED'];
  const orders = fetched.filter((o) => !TERMINAL.includes((o.status || '').toUpperCase()));
  const isNew = (s: string) => ['PENDING', 'PLACED'].includes((s || '').toUpperCase());
  // Express bought its place at the FRONT of the kitchen queue — the customer
  // paid for it and the rider cascade runs on a shorter clock.
  const expressFirst = (a: any, b: any) => Number(!!b.isExpress) - Number(!!a.isExpress);
  const newOrders = orders.filter((o) => isNew(o.status)).sort(expressFirst);
  const inProgress = orders.filter((o) => !isNew(o.status)).sort(expressFirst);
  const queueValue = orders.reduce((sum, o) => sum + Number(o.totalAmount ?? o.total ?? 0), 0);
  const today: any = (analyticsQ.data as any)?.today ?? {};

  return (
    <Screen>
      <TabHeader title={store.name} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={ordersQ.isRefetching} onRefresh={() => ordersQ.refetch()} tintColor={color.brand[500]} />}
      >
        {/* Multi-store switcher — only when the owner has more than one store. */}
        {stores.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.lg }} contentContainerStyle={{ gap: space.md }}>
            {stores.map((s: any) => (
              <Chip key={s.id} label={s.name} selected={s.id === store.id} onPress={() => switchStore(s.id)} style={{ height: 40, paddingHorizontal: space.lg }} />
            ))}
          </ScrollView>
        ) : null}

        {/* Verification suspension — commerce is off until documents are renewed */}
        {store.isVerified === false ? (
          <Pressable onPress={() => navigation?.navigate?.('Account')}>
            {({ pressed }) => (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: '#FDECEC', padding: space.md, marginBottom: space.lg, opacity: pressed ? 0.85 : 1 }}>
                <Feather name="alert-circle" size={15} color={color.error} style={{ marginTop: 1 }} />
                <T variant="label" tone="error" style={{ flex: 1 }}>
                  Store suspended — a required document is missing or expired, so new orders are off. Tap to renew it under Account.
                </T>
              </View>
            )}
          </Pressable>
        ) : null}

        {/* Today's sales — Eats-Manager hero */}
        <Card style={{ marginBottom: space.lg }}>
          <T variant="caption" weight="bold" tone="muted">
            TODAY&apos;S SALES
          </T>
          <T variant="display" style={{ marginTop: 2 }}>
            {money(today.revenue ?? 0)}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <MaterialCommunityIcons name="check-decagram" size={14} color={color.success} />
            <T variant="caption" weight="semibold" tone="muted">
              100% yours · {today.orders ?? 0} order{(today.orders ?? 0) === 1 ? '' : 's'} today
            </T>
          </View>
        </Card>

        {/* Store status */}
        <Card style={{ marginBottom: space.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: open && accepting ? color.success : color.text.muted }} />
                <T variant="body" weight="bold">
                  {!open ? 'Store closed' : accepting ? 'Open for orders' : 'Orders paused'}
                </T>
              </View>
              <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                {!open ? 'Outside business hours' : accepting ? 'Accepting new orders' : 'You’re open but not taking new orders'}
              </T>
            </View>
            <BrandSwitch value={open} onChange={() => (toggleOpen.isPending ? undefined : toggleOpen.mutate())} />
          </View>
          <PillButton
            label={accepting ? 'Pause new orders' : 'Resume orders'}
            variant="soft"
            size="md"
            style={{ marginTop: space.md }}
            loading={toggleOrders.isPending}
            onPress={() => toggleOrders.mutate()}
          />
          {toggleOrders.isError ? (
            <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
              {(toggleOrders.error as any)?.response?.data?.error?.message ?? 'Couldn’t update — try again.'}
            </T>
          ) : null}
        </Card>

        {/* KPIs */}
        <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.lg }}>
          <KpiTile icon="receipt" value={String(orders.length)} label="Active orders" />
          <KpiTile icon="cash" value={money(queueValue)} label="In queue" />
          <KpiTile icon="timer-outline" value={`${store.estimatedPrepTime ?? 30}m`} label="Prep time" />
        </View>

        {/* The Swift model — you keep everything */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            borderRadius: radius.lg,
            backgroundColor: color.brand[50],
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            marginBottom: space.lg,
          }}
        >
          <MaterialCommunityIcons name="check-decagram" size={15} color={color.success} />
          <T variant="caption" weight="semibold" tone="deep" style={{ flex: 1 }}>
            You keep 100% of every sale — Swift charges a flat weekly fee, never commission.
          </T>
        </View>

        {/* The Menu tab isn't registered for STAFF — don't show a door that goes nowhere. */}
        <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.xl }}>
          {myRole !== 'STAFF' ? (
            <PillButton label="Manage menu" variant="outline" size="md" style={{ flex: 1 }} onPress={() => navigation.navigate('Menu')} />
          ) : null}
          <PillButton label="Order history" variant="outline" size="md" style={{ flex: 1 }} onPress={() => navigation.navigate('VendorOrderHistory')} />
        </View>

        {/* New orders */}
        <T variant="heading" style={{ marginBottom: space.md }}>
          {newOrders.length ? `New orders · ${newOrders.length}` : 'New orders'}
        </T>
        {ordersQ.isLoading ? (
          <LoadingBlock />
        ) : newOrders.length === 0 ? (
          <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: color.brand[50], paddingVertical: space.xl, marginBottom: space.xl }}>
            <MaterialCommunityIcons name="check-circle-outline" size={28} color={color.text.muted} />
            <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
              You are all caught up
            </T>
          </View>
        ) : (
          newOrders.map((o) => (
            <VendorOrderCard
              key={o.id}
              order={o}
              busy={busy}
              onAction={(action) => orderAction.mutate({ id: o.id, action })}
              onOpen={() => navigation.navigate('VendorOrderDetail', { orderId: o.id, orderNumber: o.orderNumber })}
            />
          ))
        )}

        {/* In progress */}
        {inProgress.length > 0 ? (
          <>
            <T variant="heading" style={{ marginTop: space.lg, marginBottom: space.md }}>
              In progress
            </T>
            {inProgress.map((o) => (
              <VendorOrderCard
                key={o.id}
                order={o}
                busy={busy}
                onAction={(action) => orderAction.mutate({ id: o.id, action })}
                onOpen={() => navigation.navigate('VendorOrderDetail', { orderId: o.id, orderNumber: o.orderNumber })}
              />
            ))}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function VendorRoot() {
  const { store, stores, isLoading } = useVendorProfile();
  const selectedStoreId = useStoreSwitcher((s) => s.selectedStoreId);
  const setSelectedStore = useStoreSwitcher((s) => s.setSelectedStore);
  // Live order feed for the selected store, on every tab — new orders land
  // instantly (socket) with the 12s poll as fallback.
  useVendorOrdersLive(store && store.status === 'ACTIVE' ? store.id : undefined);

  // Make the default store an EXPLICIT selection before the tabs mount: every
  // vendor request then carries x-vendor-id, so the order board, menu and
  // insights all scope to the store named in the header (a stale id from a
  // previous session gets re-pointed to a store this account actually has).
  const validSelection = !!selectedStoreId && stores.some((s: any) => s.id === selectedStoreId);
  useEffect(() => {
    if (stores.length > 0 && !validSelection) setSelectedStore(stores[0].id);
  }, [stores, validSelection, setSelectedStore]);

  useEffect(() => {
    if (store) track('vendor_suite_opened', { vendorType: String(store.vendorType ?? '') });
  }, [store?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || (stores.length > 0 && !validSelection)) {
    return (
      <Screen>
        <LoadingBlock />
      </Screen>
    );
  }
  if (!store) return <BusinessSetup />;
  if (store.status !== 'ACTIVE') return <VendorOnboarding store={store} />;
  return <VendorTabs />;
}

// ─── Menu management ─────────────────────────────────────────────────────────

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
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        {item.imageUrl ? (
          <Image source={{ uri: mediaUrl(item.imageUrl)! }} style={{ width: 52, height: 52, borderRadius: radius.md }} contentFit="cover" />
        ) : (
          <View style={{ width: 52, height: 52, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
            <Feather name="image" size={18} color={color.text.muted} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <T variant="body" weight="semibold" numberOfLines={1}>
            {item.name}
          </T>
          <T variant="label" tone="muted" style={{ marginTop: 2 }}>
            {money(item.basePrice)}
            {item.stockQuantity != null ? ` · ${item.stockQuantity} in stock` : ''}
          </T>
          {item.stockQuantity != null && item.stockQuantity <= 0 ? (
            <T variant="caption" weight="semibold" tone="error" style={{ marginTop: 2 }}>
              Out of stock — hidden from customers
            </T>
          ) : item.stockQuantity != null && item.lowStockThreshold != null && item.stockQuantity <= item.lowStockThreshold ? (
            <T variant="caption" weight="semibold" style={{ marginTop: 2, color: color.warning }}>
              Low stock — restock soon
            </T>
          ) : null}
        </View>
        <Pressable onPress={() => (setAvail.isPending ? undefined : setAvail.mutate({ id: item.id, isAvailable: !available }))} hitSlop={6}>
          {({ pressed }) => (
            <View
              style={{
                borderRadius: 9999,
                paddingHorizontal: space.md,
                paddingVertical: 5,
                backgroundColor: available ? '#E8F6EE' : color.surface.base,
                borderWidth: available ? 0 : 1,
                borderColor: color.border.subtle,
                opacity: pressed ? 0.7 : 1,
              }}
            >
              <T variant="caption" weight="semibold" style={{ color: available ? color.success : color.text.muted }}>
                {available ? 'Available' : 'Sold out'}
              </T>
            </View>
          )}
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
        <PillButton label="Edit" variant="soft" size="sm" style={{ flex: 1 }} onPress={() => navigation.navigate('VendorItemEditor', { item, categories })} />
        <PillButton label="Delete" variant="outline" size="sm" style={{ flex: 1 }} loading={del.isPending} onPress={() => setConfirmDelete(true)} />
      </View>

      <PopupCard visible={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <T variant="title" center style={{ marginTop: space.lg }}>
          Delete item?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Remove &quot;{item.name}&quot; from your menu.
        </T>
        <PillButton
          label="Delete"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            setConfirmDelete(false);
            del.mutate(item.id);
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmDelete(false)} />
      </PopupCard>
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
  const [removeGroupId, setRemoveGroupId] = useState<string | null>(null);
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

  const removeOption = (groupId: string, optionId: string) => {
    delOption.mutate(optionId, {
      onSuccess: () =>
        setGroups((gs) =>
          gs.map((g) => (g.id === groupId ? { ...g, options: (g.options ?? []).filter((o: any) => o.id !== optionId) } : g)),
        ),
    });
  };

  return (
    <Card style={{ marginTop: space.lg }}>
      <T variant="heading">Options &amp; add-ons</T>
      <T variant="label" tone="muted" style={{ marginTop: 4 }}>
        Sizes, toppings, extras — customers pick these when ordering.
      </T>

      {groups.map((g) => (
        <View key={g.id} style={{ marginTop: space.md, borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T variant="body" weight="semibold">
                {g.name}
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {g.isRequired ? 'Required' : 'Optional'} · {g.maxSelect > 1 ? `up to ${g.maxSelect}` : 'pick one'}
              </T>
            </View>
            <Pressable onPress={() => setRemoveGroupId(g.id)} hitSlop={8}>
              <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                <Feather name="trash-2" size={18} color={color.text.muted} />
              </View>
            </Pressable>
          </View>

          {(g.options ?? []).map((o: any) => (
            <View key={o.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm }}>
              <T variant="label" style={{ flex: 1 }}>
                {o.name}
              </T>
              <T variant="label" tone="muted" style={{ marginRight: space.md }}>
                {Number(o.additionalPrice) > 0 ? `+${money(o.additionalPrice)}` : 'Free'}
              </T>
              <Pressable onPress={() => removeOption(g.id, o.id)} hitSlop={8}>
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                  <Feather name="x" size={16} color={color.text.muted} />
                </View>
              </Pressable>
            </View>
          ))}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm }}>
            <InlineInput
              style={{ flex: 1 }}
              value={draft(g.id).name}
              onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), name: t } }))}
              placeholder="Choice (e.g. Large)"
            />
            <InlineInput
              style={{ width: 96 }}
              value={draft(g.id).price}
              onChangeText={(t: string) => setDrafts((s) => ({ ...s, [g.id]: { ...draft(g.id), price: t } }))}
              placeholder="+GYD"
              keyboardType="number-pad"
            />
            <Pressable onPress={() => submitOption(g.id)} disabled={addOption.isPending}>
              {({ pressed }) => (
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? color.brand[600] : color.brand[500],
                  }}
                >
                  <Feather name="plus" size={18} color={color.white} />
                </View>
              )}
            </Pressable>
          </View>
        </View>
      ))}

      <View style={{ marginTop: space.md }}>
        <InlineInput value={groupName} onChangeText={setGroupName} placeholder="New group (e.g. Size, Toppings)" />
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          <Chip label="Required" selected={groupRequired} onPress={() => setGroupRequired((v) => !v)} style={{ height: 38, paddingHorizontal: space.lg }} />
          <Chip label="Multiple picks" selected={groupMulti} onPress={() => setGroupMulti((v) => !v)} style={{ height: 38, paddingHorizontal: space.lg }} />
        </View>
        <PillButton
          label="Add option group"
          variant="soft"
          size="md"
          style={{ marginTop: space.md }}
          loading={addGroup.isPending}
          disabled={!groupName.trim()}
          onPress={submitGroup}
        />
      </View>

      <PopupCard visible={!!removeGroupId} onClose={() => setRemoveGroupId(null)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <T variant="title" center style={{ marginTop: space.lg }}>
          Remove group?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Delete this option group and all its choices.
        </T>
        <PillButton
          label="Delete"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            const gid = removeGroupId!;
            setRemoveGroupId(null);
            delGroup.mutate(gid, { onSuccess: () => setGroups((gs) => gs.filter((g) => g.id !== gid)) });
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setRemoveGroupId(null)} />
      </PopupCard>
    </Card>
  );
}

/** Stock alerts from the fetched menu itself: tracked items at/below their
 *  own alert level (or sold out and auto-hidden). */
function LowStockCard({ categories, navigation, catOptions }: { categories: any[]; navigation: any; catOptions: { id: string; name: string }[] }) {
  const low = categories
    .flatMap((c: any) => c.items ?? [])
    .filter(
      (i: any) =>
        i.stockQuantity != null &&
        (i.stockQuantity <= 0 || (i.lowStockThreshold != null && i.stockQuantity <= i.lowStockThreshold)),
    )
    .sort((a: any, b: any) => a.stockQuantity - b.stockQuantity);
  if (low.length === 0) return null;
  return (
    <View style={{ borderRadius: radius.lg, backgroundColor: '#FDF1DC', padding: space.lg, marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name="alert-triangle" size={16} color={color.warning} />
        <T variant="body" weight="semibold">
          Inventory alerts · {low.length}
        </T>
      </View>
      {low.slice(0, 4).map((i: any) => (
        <Pressable key={i.id} onPress={() => navigation.navigate('VendorItemEditor', { item: i, categories: catOptions })}>
          {({ pressed }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm, opacity: pressed ? 0.7 : 1 }}>
              <T variant="label" numberOfLines={1} style={{ flex: 1, paddingRight: space.md }}>
                {i.name}
              </T>
              <T variant="label" weight="semibold" tone={i.stockQuantity <= 0 ? 'error' : 'ink'}>
                {i.stockQuantity <= 0 ? 'Out — hidden' : `${i.stockQuantity} left`}
              </T>
              <Feather name="chevron-right" size={14} color={color.text.muted} style={{ marginLeft: 4 }} />
            </View>
          )}
        </Pressable>
      ))}
      {low.length > 4 ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
          +{low.length - 4} more below their alert level
        </T>
      ) : null}
    </View>
  );
}

/** Category heading with operator controls: rename inline, delete with count. */
function CategoryHeader({ cat }: { cat: any }) {
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>(cat.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const itemCount = (cat.items ?? []).length;

  const saveName = () => {
    const n = name.trim();
    if (!n || n === cat.name) {
      setEditing(false);
      setName(cat.name);
      return;
    }
    updateCategory.mutate({ id: cat.id, data: { name: n } }, { onSuccess: () => setEditing(false) });
  };

  if (editing) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md }}>
        <InlineInput style={{ flex: 1 }} value={name} onChangeText={setName} placeholder="Category name" />
        <PillButton label="Save" size="sm" loading={updateCategory.isPending} disabled={!name.trim()} onPress={saveName} />
        <PillButton
          label="Cancel"
          variant="soft"
          size="sm"
          onPress={() => {
            setEditing(false);
            setName(cat.name);
          }}
        />
      </View>
    );
  }

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
      <T variant="heading" numberOfLines={1} style={{ flex: 1, paddingRight: space.md }}>
        {cat.name}
      </T>
      <Pressable onPress={() => setEditing(true)} hitSlop={6}>
        {({ pressed }) => (
          <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
            <Feather name="edit-2" size={16} color={color.text.muted} />
          </View>
        )}
      </Pressable>
      <Pressable onPress={() => setConfirmDelete(true)} hitSlop={6}>
        {({ pressed }) => (
          <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
            <Feather name="trash-2" size={16} color={color.text.muted} />
          </View>
        )}
      </Pressable>

      <PopupCard visible={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <T variant="title" center style={{ marginTop: space.lg }}>
          Delete “{cat.name}”?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {itemCount > 0
            ? `This removes the section AND its ${itemCount} item${itemCount === 1 ? '' : 's'} from your menu.`
            : 'This removes the empty section from your menu.'}
        </T>
        <PillButton
          label={itemCount > 0 ? `Delete section + ${itemCount} item${itemCount === 1 ? '' : 's'}` : 'Delete section'}
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={deleteCategory.isPending}
          onPress={() => {
            setConfirmDelete(false);
            deleteCategory.mutate(cat.id);
          }}
        />
        <PillButton label="Keep it" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmDelete(false)} />
      </PopupCard>
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
    <Screen>
      <SubHeader
        title="Menu & Inventory"
        navigation={navigation}
        hideBack
        action={
          catOptions.length > 0
            ? { label: '+ Item', onPress: () => navigation.navigate('VendorItemEditor', { categories: catOptions }) }
            : undefined
        }
      />
      {menuQ.isLoading ? (
        <LoadingBlock />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
          <Card style={{ marginBottom: space.md }}>
            <T variant="label" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              New category
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <InlineInput style={{ flex: 1 }} value={newCat} onChangeText={setNewCat} placeholder="e.g. Mains, Drinks" />
              <PillButton label="Add" size="md" loading={createCategory.isPending} disabled={newCat.trim().length < 1} onPress={addCategory} />
            </View>
          </Card>

          <Pressable onPress={() => navigation.navigate('VendorBulkImport')}>
            {({ pressed }) => (
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg, opacity: pressed ? 0.8 : 1 }}>
                <IconChip icon="upload-cloud" />
                <View style={{ flex: 1 }}>
                  <T variant="body" weight="semibold">
                    Bulk import catalogue
                  </T>
                  <T variant="caption" tone="muted">
                    Paste a CSV — we map the columns for you
                  </T>
                </View>
                <Feather name="chevron-right" size={18} color={color.text.muted} />
              </Card>
            )}
          </Pressable>

          <LowStockCard categories={categories} navigation={navigation} catOptions={catOptions} />

          {categories.length === 0 ? (
            <EmptyState icon="book-open" title="Build your menu" body="Add a category above, then start adding items." />
          ) : (
            categories.map((cat) => (
              <View key={cat.id} style={{ marginBottom: space.lg }}>
                <CategoryHeader cat={cat} />
                {(cat.items ?? []).length === 0 ? (
                  <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
                    No items yet.
                  </T>
                ) : (
                  cat.items.map((it: any) => <MenuItemRow key={it.id} item={it} navigation={navigation} categories={catOptions} />)
                )}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </Screen>
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
  const [photoErr, setPhotoErr] = useState<string | null>(null);

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
  const [radiusKm, setRadiusKm] = useState<string>(existingBooking.serviceRadiusKm != null ? String(existingBooking.serviceRadiusKm) : '5');

  const priceNum = Number(price);
  const valid =
    name.trim().length >= 1 && Number.isFinite(priceNum) && priceNum >= 0 && !!categoryId && (!isService || days.length > 0);
  const busy = save.isPending || uploadImage.isPending;
  const previewUri = localPhoto?.uri ?? mediaUrl(existing?.imageUrl) ?? undefined;

  const [photoMenu, setPhotoMenu] = useState(false);

  const applyAsset = (res: ImagePicker.ImagePickerResult) => {
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setLocalPhoto({ uri: a.uri, name: a.fileName ?? 'item.jpg', type: a.mimeType ?? 'image/jpeg' });
  };

  const pickFromLibrary = async () => {
    setPhotoMenu(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    applyAsset(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 }));
  };

  const takePhoto = async () => {
    setPhotoMenu(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setPhotoErr('Camera access needed — allow it in Settings to take photos.');
      return;
    }
    setPhotoErr(null);
    applyAsset(await ImagePicker.launchCameraAsync({ quality: 0.8 }));
  };

  const submit = async () => {
    if (!valid || busy) return;
    const stockNum = stock.trim() === '' ? undefined : Number(stock);
    const bookingConfig = isService
      ? {
          durationMinutes: duration,
          slots: days.map((d) => ({ dayOfWeek: d, start: startTime, end: endTime })),
          serviceMode: mode,
          ...(mode !== 'AT_BUSINESS' ? { serviceRadiusKm: Number(radiusKm) || 0 } : {}),
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
    <Screen>
      <SubHeader title={existing ? 'Edit Item' : 'New Item'} navigation={navigation} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Photo */}
        <Pressable onPress={() => setPhotoMenu(true)}>
          {({ pressed }) => (
            <View
              style={{
                height: 160,
                borderRadius: radius.lg,
                overflow: 'hidden',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: color.brand[50],
                marginBottom: space.sm,
                opacity: pressed ? 0.85 : 1,
              }}
            >
              {previewUri ? (
                <Image source={{ uri: previewUri }} style={{ width: '100%', height: 160 }} contentFit="cover" />
              ) : (
                <View style={{ alignItems: 'center' }}>
                  <Feather name="camera" size={24} color={color.brand[500]} />
                  <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
                    Add a photo
                  </T>
                </View>
              )}
            </View>
          )}
        </Pressable>
        {previewUri ? (
          <View style={{ alignItems: 'center', marginBottom: space.lg }}>
            <LinkText label={uploadImage.isPending ? 'Uploading…' : 'Change photo'} onPress={() => setPhotoMenu(true)} />
          </View>
        ) : null}
        {photoErr ? (
          <T variant="caption" tone="error" center style={{ marginBottom: space.md }}>
            {photoErr}
          </T>
        ) : null}

        <View style={{ gap: space.md }}>
          <LabeledInput value={name} onChangeText={setName} placeholder="Item name" />
          <LabeledInput value={price} onChangeText={setPrice} placeholder="Price (GYD)" keyboardType="decimal-pad" />
          <InlineInput value={description} onChangeText={setDescription} placeholder="Description (optional)" multiline />
        </View>

        {isService ? (
          <Card style={{ marginTop: space.lg }}>
            <T variant="heading" style={{ marginBottom: space.md }}>
              Appointment booking
            </T>

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Appointment length
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
              {[15, 30, 45, 60, 90, 120].map((m) => (
                <Chip key={m} label={`${m} min`} selected={duration === m} onPress={() => setDuration(m)} style={{ height: 36, paddingHorizontal: space.md }} />
              ))}
            </View>

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Available days
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
              {DAY_LABELS.map((d, i) => (
                <Chip
                  key={i}
                  label={d}
                  selected={days.includes(i)}
                  onPress={() => setDays((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))}
                  style={{ height: 36, paddingHorizontal: space.md }}
                />
              ))}
            </View>

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Hours
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
              <InlineInput style={{ flex: 1 }} value={startTime} onChangeText={setStartTime} placeholder="09:00" center />
              <T variant="label" tone="muted">
                to
              </T>
              <InlineInput style={{ flex: 1 }} value={endTime} onChangeText={setEndTime} placeholder="17:00" center />
            </View>

            <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              Where does it happen?
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md }}>
              <Chip label="At my place" selected={mode === 'AT_BUSINESS'} onPress={() => setMode('AT_BUSINESS')} style={{ height: 38, paddingHorizontal: space.md }} />
              <Chip label="I travel to them" selected={mode === 'MOBILE'} onPress={() => setMode('MOBILE')} style={{ height: 38, paddingHorizontal: space.md }} />
              <Chip label="Both" selected={mode === 'BOTH'} onPress={() => setMode('BOTH')} style={{ height: 38, paddingHorizontal: space.md }} />
            </View>

            {mode !== 'AT_BUSINESS' ? (
              <View>
                <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                  How far will you travel from your store? (km)
                </T>
                <InlineInput value={radiusKm} onChangeText={setRadiusKm} placeholder="5" keyboardType="number-pad" />
              </View>
            ) : null}
          </Card>
        ) : (
          <>
            {/* Inventory — used by groceries/shops; optional for restaurants */}
            <T variant="label" weight="semibold" tone="muted" style={{ marginTop: space.lg, marginBottom: space.sm }}>
              Inventory (optional)
            </T>
            <View style={{ gap: space.md }}>
              <View style={{ flexDirection: 'row', gap: space.md }}>
                <InlineInput style={{ flex: 1 }} value={stock} onChangeText={setStock} placeholder="Stock qty" keyboardType="number-pad" />
                <InlineInput style={{ flex: 1 }} value={unit} onChangeText={setUnit} placeholder="Unit (kg, ea)" />
              </View>
              <InlineInput value={sku} onChangeText={setSku} placeholder="SKU / barcode (optional)" />
              <InlineInput value={lowStock} onChangeText={setLowStock} placeholder="Low-stock alert at (e.g. 5)" keyboardType="number-pad" />
              {stock.trim() !== '' ? (
                <T variant="caption" tone="muted">
                  Tracked items sell down automatically and hide at 0. You’ll get an alert at your low-stock level.
                </T>
              ) : null}
            </View>
          </>
        )}

        {existing && !isService ? (
          <ModifiersSection item={existing} />
        ) : !isService ? (
          <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
            Save the item first to add options &amp; add-ons (sizes, toppings, extras).
          </T>
        ) : null}

        <T variant="label" weight="semibold" tone="muted" style={{ marginTop: space.lg, marginBottom: space.sm }}>
          Category
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.lg }}>
          {categories.map((c) => (
            <Chip key={c.id} label={c.name} selected={c.id === categoryId} onPress={() => setCategoryId(c.id)} style={{ height: 38, paddingHorizontal: space.md }} />
          ))}
        </View>

        <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.lg }}>
          <Chip label={available ? 'Available' : 'Sold out'} selected={available} onPress={() => setAvailable((v) => !v)} style={{ height: 38, paddingHorizontal: space.md }} />
          <Chip label="★ Popular" selected={popular} onPress={() => setPopular((v) => !v)} style={{ height: 38, paddingHorizontal: space.md }} />
        </View>

        {save.isError ? (
          <T variant="label" tone="error" style={{ marginBottom: space.md }}>
            Couldn&apos;t save. Check the details and try again.
          </T>
        ) : null}
        <PillButton label={existing ? 'Save changes' : 'Add item'} loading={busy} disabled={!valid} onPress={submit} />
      </ScrollView>

      {/* Photo source picker — kit popup */}
      <PopupCard visible={photoMenu} onClose={() => setPhotoMenu(false)}>
        <IconChip icon="camera" size={56} />
        <T variant="title" center style={{ marginTop: space.lg }}>
          Item photo
        </T>
        <PillButton label="Take photo" style={{ alignSelf: 'stretch', marginTop: space['2xl'] }} onPress={takePhoto} />
        <PillButton label="Choose from library" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={pickFromLibrary} />
        {localPhoto ? (
          <PillButton
            label="Remove selected photo"
            variant="outline"
            style={{ alignSelf: 'stretch', marginTop: space.md }}
            onPress={() => {
              setLocalPhoto(null);
              setPhotoMenu(false);
            }}
          />
        ) : null}
      </PopupCard>
    </Screen>
  );
}

// Orders tab — the (cached) store, then the live order board.
function VendorOrdersTab({ navigation }: any) {
  const { store } = useVendorProfile();
  if (!store) {
    return (
      <Screen>
        <LoadingBlock />
      </Screen>
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
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <T variant="body" weight="semibold">
          Last {daily.length} days
        </T>
        <T variant="label" tone="muted">
          {money(totals.revenue)} · {totals.orders} orders
        </T>
      </View>
      {totals.orders === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.md }}>
          No completed orders yet — sales will chart here.
        </T>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: CHART_HEIGHT, marginTop: space.md }}>
            {daily.map((d) => (
              <View
                key={d.date}
                style={{
                  flex: 1,
                  borderTopLeftRadius: 3,
                  borderTopRightRadius: 3,
                  height: Math.max(3, Math.round((d.revenue / max) * CHART_HEIGHT)),
                  backgroundColor: d.revenue > 0 ? color.brand[500] : color.border.subtle,
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm }}>
            <T variant="caption" tone="muted">
              {dayLabel(daily[0]!.date)}
            </T>
            <T variant="caption" tone="muted">
              peak {money(max)}
            </T>
            <T variant="caption" tone="muted">
              {dayLabel(daily[daily.length - 1]!.date)}
            </T>
          </View>
        </>
      )}
    </Card>
  );
}

function TopItemsCard({ items }: { items: any[] }) {
  const ranked = items.filter((i) => i.totalOrdered > 0 || i.recentOrders > 0);
  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="body" weight="semibold">
        Top items
      </T>
      {ranked.length === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Your best sellers will rank here once orders come in.
        </T>
      ) : (
        ranked.map((item, i) => (
          <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm }}>
            <T variant="label" weight="bold" tone="muted" style={{ width: 24 }}>
              {i + 1}
            </T>
            {item.imageUrl ? (
              <Image source={{ uri: mediaUrl(item.imageUrl)! }} style={{ width: 34, height: 34, borderRadius: 8 }} contentFit="cover" />
            ) : (
              <View style={{ width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
                <Feather name="image" size={14} color={color.text.muted} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: space.sm }}>
              <T variant="label" weight="semibold" numberOfLines={1}>
                {item.name}
              </T>
              <T variant="caption" tone="muted">
                {item.category?.name ?? ''}
              </T>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <T variant="label" weight="semibold">
                {item.recentOrders} this month
              </T>
              <T variant="caption" tone="muted">
                {item.totalOrdered} all time
              </T>
            </View>
          </View>
        ))
      )}
    </Card>
  );
}

/** Busy-hours mini chart (§4.1): when the orders actually come in. */
function BusyHoursCard() {
  const q = useBusyHours();
  if (q.isLoading) return null;
  const data = q.data;
  if (!data) return null;
  const hours: Array<{ hour: number; orders: number }> = data.hours ?? [];
  const max = Math.max(...hours.map((h) => h.orders), 1);
  const fmtHour = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <T variant="body" weight="semibold">
          Busy hours
        </T>
        {data.peak ? (
          <T variant="label" tone="muted">
            peak {fmtHour(data.peak.hour)}
          </T>
        ) : null}
      </View>
      {data.total === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Order times will map out here — staff up for the rush.
        </T>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 64, marginTop: space.md }}>
            {hours.map((h) => (
              <View
                key={h.hour}
                style={{
                  flex: 1,
                  borderTopLeftRadius: 2,
                  borderTopRightRadius: 2,
                  height: Math.max(3, Math.round((h.orders / max) * 64)),
                  backgroundColor: h.orders > 0 ? color.brand[500] : color.border.subtle,
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm }}>
            {['12am', '6am', '12pm', '6pm', '11pm'].map((l) => (
              <T key={l} variant="caption" tone="muted">
                {l}
              </T>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

/** Reviews with the operator reply box (§4.1 "see ratings, respond"). */
function ReviewsCard() {
  const reviewsQ = useMyStoreReviews();
  const respond = useRespondReview();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const reviews: any[] = (reviewsQ.data?.data ?? []).slice(0, 10);
  if (reviewsQ.isLoading) return null;

  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="body" weight="semibold">
        Recent reviews
      </T>
      {reviews.length === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Reviews land here after customers rate their orders.
        </T>
      ) : (
        reviews.map((r) => (
          <View key={r.id} style={{ marginTop: space.sm, borderTopWidth: 1, borderTopColor: color.border.subtle, paddingTop: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T variant="label" weight="semibold" style={{ flex: 1 }}>
                {r.rater?.firstName ?? 'Customer'} · <T variant="label" style={{ color: color.warning }}>{'★'.repeat(Number(r.score) || 0)}</T>
              </T>
              <T variant="caption" tone="muted">
                {new Date(r.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              </T>
            </View>
            {r.comment ? (
              <T variant="label" tone="muted" style={{ marginTop: 4 }}>
                {r.comment}
              </T>
            ) : null}

            {r.response && openId !== r.id ? (
              <View style={{ marginLeft: space.lg, marginTop: space.sm, borderRadius: radius.md, backgroundColor: color.surface.subtle, paddingHorizontal: space.md, paddingVertical: space.sm }}>
                <T variant="caption" tone="muted">
                  You replied: {r.response}
                </T>
                <LinkText
                  label="Edit reply"
                  onPress={() => {
                    setOpenId(r.id);
                    setDrafts((s) => ({ ...s, [r.id]: r.response }));
                  }}
                />
              </View>
            ) : openId === r.id ? (
              <View style={{ marginTop: space.sm }}>
                <InlineInput
                  multiline
                  value={drafts[r.id] ?? ''}
                  onChangeText={(t: string) => setDrafts((s) => ({ ...s, [r.id]: t }))}
                  placeholder="Write a public reply…"
                />
                <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.sm }}>
                  <PillButton
                    label="Post reply"
                    size="md"
                    style={{ flex: 1 }}
                    loading={respond.isPending}
                    disabled={!(drafts[r.id] ?? '').trim()}
                    onPress={() => respond.mutate({ id: r.id, response: (drafts[r.id] ?? '').trim() }, { onSuccess: () => setOpenId(null) })}
                  />
                  <PillButton label="Cancel" variant="soft" size="md" style={{ flex: 1 }} onPress={() => setOpenId(null)} />
                </View>
              </View>
            ) : (
              <View style={{ marginTop: space.sm }}>
                <LinkText label="Reply" onPress={() => setOpenId(r.id)} />
              </View>
            )}
          </View>
        ))
      )}
    </Card>
  );
}

/** Ratings histogram — the reviews endpoint's score distribution, drawn as bars. */
function RatingsCard() {
  const reviewsQ = useMyStoreReviews();
  const summary = reviewsQ.data?.summary;
  if (!summary || !summary.totalReviews) return null;
  const dist = summary.distribution ?? {};
  const max = Math.max(...[1, 2, 3, 4, 5].map((s) => Number(dist[String(s)] ?? 0)), 1);
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', gap: space.xl }}>
        <View style={{ alignItems: 'center', justifyContent: 'center', minWidth: 88 }}>
          <T variant="display">{Number(summary.averageRating).toFixed(1)}</T>
          <View style={{ flexDirection: 'row', gap: 1, marginTop: 2 }}>
            {[1, 2, 3, 4, 5].map((s) => (
              <MaterialCommunityIcons
                key={s}
                name={Number(summary.averageRating) >= s - 0.25 ? 'star' : 'star-outline'}
                size={13}
                color={color.warning}
              />
            ))}
          </View>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {summary.totalReviews} rating{summary.totalReviews === 1 ? '' : 's'}
          </T>
        </View>
        <View style={{ flex: 1, justifyContent: 'center', gap: 4 }}>
          {[5, 4, 3, 2, 1].map((s) => {
            const n = Number(dist[String(s)] ?? 0);
            return (
              <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <T variant="caption" tone="muted" style={{ width: 10, textAlign: 'right' }}>
                  {s}
                </T>
                <View style={{ flex: 1, height: 7, borderRadius: 4, backgroundColor: color.border.subtle, overflow: 'hidden' }}>
                  <View style={{ width: `${Math.round((n / max) * 100)}%`, height: 7, borderRadius: 4, backgroundColor: n > 0 ? color.warning : 'transparent' }} />
                </View>
                <T variant="caption" tone="muted" style={{ width: 22 }}>
                  {n}
                </T>
              </View>
            );
          })}
        </View>
      </View>
    </Card>
  );
}

/**
 * Operational quality (Eats-Manager style): how fast the store answers, how
 * honest its prep quote is, and how often orders die. All real timestamps
 * from /vendor/analytics/ops — rows hide (not zero-fill) when there's no data.
 */
function OpsCard({ ops, period }: { ops: any; period: number }) {
  if (!ops || !ops.placedOrders) return null;
  const prepDelta =
    ops.avgPrepMinutes != null && ops.avgQuotedPrepMinutes != null
      ? Math.round((ops.avgPrepMinutes - ops.avgQuotedPrepMinutes) * 10) / 10
      : null;
  return (
    <Card style={{ marginBottom: space.lg }}>
      <T variant="body" weight="bold">
        Operations · {period}d
      </T>
      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
        {ops.acceptanceRate != null ? (
          <KpiTile icon="check-circle-outline" value={`${ops.acceptanceRate}%`} label="Acceptance" />
        ) : null}
        {ops.cancellationRate != null ? (
          <KpiTile icon="close-circle-outline" value={`${ops.cancellationRate}%`} label="Cancelled" />
        ) : null}
        {ops.avgAcceptMinutes != null ? (
          <KpiTile icon="timer-sand" value={`${ops.avgAcceptMinutes}m`} label="To accept" />
        ) : null}
      </View>
      {ops.avgPrepMinutes != null ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
          Prep runs ~{ops.avgPrepMinutes} min
          {ops.avgQuotedPrepMinutes != null ? ` against a ~${ops.avgQuotedPrepMinutes} min quote` : ''}
          {prepDelta != null && prepDelta > 2 ? ' — quote a little more time so customers aren’t kept waiting.' : '.'}
        </T>
      ) : null}
      {ops.vendorCancellations > 0 ? (
        <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
          {ops.vendorCancellations} cancelled by the store — keep stock and hours current to protect your rating.
        </T>
      ) : null}
    </Card>
  );
}

const PERIODS = [7, 30, 90] as const;

/** Sum a window off the endpoint's own daily series (dates ascending). */
function windowTotals(daily: any[], take: number) {
  const sum = (rows: any[], k: string) => rows.reduce((s, d) => s + Number(d?.[k] ?? 0), 0);
  const cur = daily.slice(-take);
  const prevRows = daily.slice(-take * 2, -take);
  const prev = prevRows.length === take ? { revenue: sum(prevRows, 'revenue'), orders: sum(prevRows, 'orders') } : null;
  return { curDaily: cur, cur: { revenue: sum(cur, 'revenue'), orders: sum(cur, 'orders') }, prev };
}

function VendorInsightsScreen() {
  const q = useVendorAnalytics();
  // Fetch double the window so "vs the previous N days" comes from the same
  // real series (90 is the endpoint's max — no prior window at that depth).
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(7);
  const revenueQ = useVendorRevenue(period === 90 ? 90 : period * 2);
  const opsQ = useVendorOps(period);
  const popularQ = usePopularItems(8);
  const a: any = q.data ?? {};
  const v: any = a.vendor ?? {};

  const daily: any[] = revenueQ.data?.daily ?? [];
  const w = windowTotals(daily, Math.min(period, daily.length || period));
  const aovCur = w.cur.orders > 0 ? w.cur.revenue / w.cur.orders : 0;
  const aovPrev = w.prev && w.prev.orders > 0 ? w.prev.revenue / w.prev.orders : null;

  return (
    <Screen>
      <TabHeader title="Insights" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={q.isRefetching}
            onRefresh={() => {
              q.refetch();
              revenueQ.refetch();
              popularQ.refetch();
            }}
            tintColor={color.brand[500]}
          />
        }
      >
        {q.isLoading ? (
          <LoadingBlock />
        ) : (
          <>
            {/* Live today, straight off the overview endpoint */}
            <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.lg }}>
              <KpiTile icon="receipt" value={String(a.today?.orders ?? 0)} label="Orders today" />
              <KpiTile icon="cash" value={money(a.today?.revenue ?? 0)} label="Revenue today" />
              <KpiTile icon="bell-ring" value={String(a.pendingOrders ?? 0)} label="Pending now" />
            </View>

            {/* Performance window */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md }}>
              <T variant="heading">Performance</T>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                {PERIODS.map((p) => (
                  <Chip key={p} label={`${p}d`} selected={period === p} onPress={() => setPeriod(p)} style={{ height: 34, paddingHorizontal: space.md }} />
                ))}
              </View>
            </View>
            {w.curDaily.length ? <RevenueChart daily={w.curDaily} totals={{ revenue: w.cur.revenue, orders: w.cur.orders }} /> : null}
            <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.sm }}>
              <KpiTile
                icon="cash-multiple"
                value={money(w.cur.revenue)}
                label={`Revenue · ${period}d`}
                delta={<DeltaBadge cur={w.cur.revenue} prev={w.prev?.revenue ?? null} />}
              />
              <KpiTile
                icon="receipt"
                value={String(w.cur.orders)}
                label={`Orders · ${period}d`}
                delta={<DeltaBadge cur={w.cur.orders} prev={w.prev?.orders ?? null} />}
              />
              <KpiTile
                icon="chart-line"
                value={money(aovCur)}
                label="Avg order"
                delta={aovPrev != null ? <DeltaBadge cur={aovCur} prev={aovPrev} /> : undefined}
              />
            </View>
            {w.prev ? (
              <T variant="caption" tone="muted" style={{ marginBottom: space.lg }}>
                Change vs the previous {period} days.
              </T>
            ) : (
              <View style={{ marginBottom: space.lg }} />
            )}

            <OpsCard ops={opsQ.data} period={period} />

            {popularQ.data ? <TopItemsCard items={popularQ.data} /> : null}
            <BusyHoursCard />
            <RatingsCard />
            <ReviewsCard />
            <Card style={{ marginBottom: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <MaterialCommunityIcons name="star" size={18} color={color.warning} />
                  <T variant="body" weight="semibold">
                    {Number(v.averageRating ?? 0).toFixed(1)}
                  </T>
                  <T variant="label" tone="muted">
                    ({v.totalRatings ?? 0})
                  </T>
                </View>
                <T variant="label" tone="muted">
                  {v.totalOrders ?? 0} lifetime orders
                </T>
              </View>
            </Card>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <KpiTile icon="silverware-fork-knife" value={String(a.activeMenuItems ?? 0)} label="Active items" />
              <KpiTile icon="calendar-month" value={String(a.month?.orders ?? 0)} label="Orders / month" />
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function VendorAccountScreen() {
  const { store, myRole } = useVendorProfile();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const isOwner = myRole === 'OWNER';
  const isManager = myRole !== 'STAFF';
  const sub = useVendorSubscription(isOwner);
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
    <Screen>
      <TabHeader title="Account" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Store identity */}
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
            <MaterialCommunityIcons name="storefront" size={26} color={color.brand[600]} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="heading" numberOfLines={1}>
              {store?.name ?? 'Your store'}
            </T>
            <T variant="label" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
              {prettyVendorType(store?.vendorType)}
              {store?.city ? ` · ${store.city}` : ''}
            </T>
          </View>
        </Card>

        <Card style={{ marginBottom: space.lg, paddingVertical: space.sm }}>
          <SettingsRow icon="refresh-cw" label="Switch app" sub="Swift · Swift Driver" onPress={() => setSwitcherOpen(true)} />
        </Card>

        {isOwner ? <SubscriptionCard sub={sub.data} phone={store?.phone} /> : null}

        {isOwner && store?.vendorType ? <VendorDocumentsSection vendorType={store.vendorType} /> : null}

        {isManager ? <StoreQrCard /> : null}

        {isManager ? <PromosSection /> : null}

        {isOwner ? <StaffSection /> : null}

        {!isManager ? (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="label" weight="semibold">
              Staff account
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
              You work the order queue and can mark items sold out. Menus, hours and billing stay with the manager and owner.
            </T>
          </Card>
        ) : null}

        {isManager ? (
          <>
            <T variant="heading" style={{ marginBottom: space.md }}>
              Business hours
            </T>
            {hoursQ.isLoading ? (
              <LoadingBlock />
            ) : (
              <Card style={{ marginBottom: space.lg }}>
                {days.map((d) => (
                  <View key={d.dayOfWeek} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
                    <T variant="label" weight="semibold" style={{ width: 40 }}>
                      {DAY_LABELS[d.dayOfWeek]}
                    </T>
                    {d.isClosed ? (
                      <T variant="label" tone="muted" style={{ flex: 1, paddingHorizontal: space.sm }}>
                        Closed
                      </T>
                    ) : (
                      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.sm }}>
                        <View style={{ flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: color.border.subtle, backgroundColor: color.surface.base }}>
                          <TextInput
                            value={d.openTime}
                            onChangeText={(t) => setDay(d.dayOfWeek, { openTime: t })}
                            placeholder="08:00"
                            placeholderTextColor={color.text.muted}
                            style={{ fontFamily: 'Inter', fontSize: 13, color: color.text.primary, textAlign: 'center', paddingVertical: 8 }}
                          />
                        </View>
                        <T variant="label" tone="muted">
                          –
                        </T>
                        <View style={{ flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: color.border.subtle, backgroundColor: color.surface.base }}>
                          <TextInput
                            value={d.closeTime}
                            onChangeText={(t) => setDay(d.dayOfWeek, { closeTime: t })}
                            placeholder="22:00"
                            placeholderTextColor={color.text.muted}
                            style={{ fontFamily: 'Inter', fontSize: 13, color: color.text.primary, textAlign: 'center', paddingVertical: 8 }}
                          />
                        </View>
                      </View>
                    )}
                    <BrandSwitch value={!d.isClosed} onChange={(val) => setDay(d.dayOfWeek, { isClosed: !val })} />
                  </View>
                ))}
                <PillButton label="Save hours" size="md" loading={setHours.isPending} style={{ marginTop: space.sm }} disabled={days.length === 0} onPress={() => setHours.mutate(days)} />
                {setHours.isSuccess ? (
                  <T variant="caption" tone="success" center style={{ marginTop: space.sm }}>
                    Hours updated
                  </T>
                ) : null}
              </Card>
            )}
          </>
        ) : null}
      </ScrollView>

      <RoleSwitcherSheet visible={switcherOpen} current="vendor" onClose={() => setSwitcherOpen(false)} />
    </Screen>
  );
}

/** Billing state exactly as the subscription engine records it: trial, grace,
 *  rate and the next billing date (weekly flat fee — the whole Swift model). */
/**
 * The business's legal documents, owner-only: live checklist status with
 * expiry — an approved document re-opens for upload inside its 30-day renewal
 * window, and an expired one explains exactly why commerce stopped.
 */
function VendorDocumentsSection({ vendorType }: { vendorType: string }) {
  const { data: status, isLoading, isError, refetch } = useVerificationStatus<any>(vendorType);
  return (
    <View style={{ marginBottom: space.lg }}>
      <DocumentChecklist role={vendorType} status={status} isLoading={isLoading} isError={isError} onRetry={refetch} />
    </View>
  );
}

function SubscriptionCard({ sub, phone }: { sub: any; phone?: string }) {
  const pill = !sub
    ? { label: 'Inactive', tone: 'brand' as const }
    : sub.isTrialActive
      ? { label: 'Free trial', tone: 'brand' as const }
      : sub.isInGracePeriod
        ? { label: 'Grace period', tone: 'error' as const }
        : sub.status === 'ACTIVE'
          ? { label: 'Active', tone: 'success' as const }
          : { label: String(sub.status ?? '').toLowerCase() || 'Inactive', tone: 'neutral' as const };
  const subLine = !sub
    ? 'Not active yet'
    : sub.isTrialActive && sub.trialEndDate
      ? `Trial ends ${fmtDate(sub.trialEndDate)} · then ${money(sub.weeklyRate)}/week`
      : sub.isInGracePeriod && sub.gracePeriodEnd
        ? `Pay by ${fmtDate(sub.gracePeriodEnd)} to stay online`
        : `${money(sub.customRate ?? sub.weeklyRate)}/week${sub.nextBillingDate ? ` · next bill ${fmtDate(sub.nextBillingDate)}` : ''}`;
  return (
    <Card style={{ marginBottom: space.lg, paddingVertical: space.sm }}>
      <SettingsRow icon="credit-card" label="Subscription" sub={subLine} right={<TonePill label={pill.label} tone={pill.tone} />} />
      {phone ? <SettingsRow icon="phone" label="Phone" right={<T variant="label" tone="muted">{phone}</T>} /> : null}
    </Card>
  );
}

/** Storefront QR (real /vendor/qr payload): print it, customers scan to order. */
function StoreQrCard() {
  const qrQ = useVendorQr();
  if (!qrQ.data?.svg) return null;
  return (
    <Card style={{ alignItems: 'center', marginBottom: space.lg }}>
      <T variant="body" weight="semibold" style={{ alignSelf: 'flex-start' }}>
        Your store QR
      </T>
      <View style={{ padding: space.md, borderRadius: radius.lg, backgroundColor: color.white, marginTop: space.md }}>
        <SvgXml xml={qrQ.data.svg} width={168} height={168} />
      </View>
      <T variant="caption" weight="semibold" tone="brand" style={{ marginTop: space.md }}>
        {qrQ.data.deepLink}
      </T>
      <T variant="caption" tone="muted" center style={{ marginTop: 4 }}>
        Print it for your counter — customers scan to open your storefront and order.
      </T>
    </Card>
  );
}

/**
 * Operator promotions (master plan §4.2): the store's own promo codes.
 * Create %/$ codes with an end date, pause/resume, delete. Customers see
 * live codes on the storefront and apply them at checkout.
 */
function PromosSection() {
  const promosQ = useVendorPromos();
  const createPromo = useCreatePromo();
  const updatePromo = useUpdatePromo();
  const deletePromo = useDeletePromo();

  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<'PERCENTAGE' | 'FIXED_AMOUNT'>('PERCENTAGE');
  const [value, setValue] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [days, setDays] = useState(7);

  const promos: any[] = promosQ.data ?? [];
  const errMsg =
    (createPromo.error as any)?.response?.data?.error?.message ?? (createPromo.error as any)?.response?.data?.message;

  const submit = () => {
    const v = Number(value);
    if (!code.trim() || !desc.trim() || !Number.isFinite(v) || v <= 0) return;
    const validUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    createPromo.mutate(
      {
        code: code.trim().toUpperCase(),
        description: desc.trim(),
        discountType: kind,
        discountValue: v,
        ...(Number(minOrder) > 0 ? { minOrderAmount: Number(minOrder) } : {}),
        validUntil,
      },
      {
        onSuccess: () => {
          setShowForm(false);
          setCode('');
          setDesc('');
          setValue('');
          setMinOrder('');
        },
      },
    );
  };

  return (
    <>
      <T variant="heading" style={{ marginBottom: space.md }}>
        Promotions
      </T>
      <Card style={{ marginBottom: space.lg }}>
        {promos.map((p) => {
          const expired = new Date(p.validUntil).getTime() < Date.now();
          return (
            <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <T variant="label" weight="bold" style={{ letterSpacing: 1 }}>
                    {p.code}
                  </T>
                  <TonePill label={expired ? 'Expired' : p.isActive ? 'Live' : 'Paused'} tone={expired ? 'neutral' : p.isActive ? 'success' : 'neutral'} />
                </View>
                <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                  {p.discountType === 'PERCENTAGE' ? `${Number(p.discountValue)}% off` : `${money(p.discountValue)} off`}
                  {p.minOrderAmount ? ` over ${money(p.minOrderAmount)}` : ''} · used {p.currentUses}×
                </T>
              </View>
              {!expired ? (
                <PillButton
                  label={p.isActive ? 'Pause' : 'Resume'}
                  variant="soft"
                  size="sm"
                  style={{ marginRight: space.sm }}
                  disabled={updatePromo.isPending}
                  onPress={() => updatePromo.mutate({ id: p.id, data: { isActive: !p.isActive } })}
                />
              ) : null}
              <Pressable onPress={() => deletePromo.mutate(p.id)} hitSlop={8}>
                <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                  <Feather name="trash-2" size={16} color={color.text.muted} />
                </View>
              </Pressable>
            </View>
          );
        })}
        {promos.length === 0 && !promosQ.isLoading ? (
          <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
            No codes yet — run your first promotion and it shows on your storefront.
          </T>
        ) : null}

        {showForm ? (
          <View style={{ gap: space.md }}>
            <InlineInput value={code} onChangeText={setCode} placeholder="Code (e.g. SAVE20)" autoCapitalize="characters" />
            <InlineInput value={desc} onChangeText={setDesc} placeholder="What customers see (e.g. 20% off this week)" />
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Chip label="% off" selected={kind === 'PERCENTAGE'} onPress={() => setKind('PERCENTAGE')} style={{ height: 38, paddingHorizontal: space.md }} />
              <Chip label="GYD off" selected={kind === 'FIXED_AMOUNT'} onPress={() => setKind('FIXED_AMOUNT')} style={{ height: 38, paddingHorizontal: space.md }} />
            </View>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <InlineInput style={{ flex: 1 }} value={value} onChangeText={setValue} placeholder={kind === 'PERCENTAGE' ? '% (e.g. 20)' : 'GYD (e.g. 500)'} keyboardType="number-pad" />
              <InlineInput style={{ flex: 1 }} value={minOrder} onChangeText={setMinOrder} placeholder="Min order (opt.)" keyboardType="number-pad" />
            </View>
            <T variant="caption" weight="semibold" tone="muted">
              Runs for
            </T>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {[3, 7, 14, 30].map((d) => (
                <Chip key={d} label={`${d} days`} selected={days === d} onPress={() => setDays(d)} style={{ height: 36, paddingHorizontal: space.md }} />
              ))}
            </View>
            {errMsg ? (
              <T variant="label" tone="error">
                {errMsg}
              </T>
            ) : null}
            <PillButton
              label="Launch promotion"
              size="md"
              loading={createPromo.isPending}
              disabled={!code.trim() || !desc.trim() || !(Number(value) > 0)}
              onPress={submit}
            />
          </View>
        ) : (
          <PillButton label="New promotion" variant="soft" size="md" onPress={() => setShowForm(true)} />
        )}
      </Card>
    </>
  );
}

/**
 * Staff & roles (master plan §4.1) — the owner's team panel: add an existing
 * Swift account by phone as MANAGER or STAFF, flip roles, remove access.
 */
function StaffSection() {
  const staffQ = useVendorStaff();
  const addStaff = useAddStaff();
  const removeStaff = useRemoveStaff();
  const updateRole = useUpdateStaffRole();
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'MANAGER' | 'STAFF'>('STAFF');
  const [removing, setRemoving] = useState<any | null>(null);

  const members: any[] = staffQ.data ?? [];
  const errMsg = (addStaff.error as any)?.response?.data?.error?.message ?? (addStaff.error as any)?.response?.data?.message;

  const submit = () => {
    const p = phone.trim();
    if (p.length < 10) return;
    addStaff.mutate({ phone: p, role }, { onSuccess: () => setPhone('') });
  };

  return (
    <>
      <T variant="heading" style={{ marginBottom: space.md }}>
        Team
      </T>
      <Card style={{ marginBottom: space.lg }}>
        {members.map((m) => (
          <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
            {m.user?.avatar ? (
              <Image source={{ uri: mediaUrl(m.user.avatar) ?? undefined }} style={{ width: 36, height: 36, borderRadius: 18 }} contentFit="cover" />
            ) : (
              <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
                <Feather name="user" size={16} color={color.text.muted} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: space.sm }}>
              <T variant="label" weight="semibold">
                {[m.user?.firstName, m.user?.lastName].filter(Boolean).join(' ')}
              </T>
              <T variant="caption" tone="muted">
                {m.user?.phone}
              </T>
            </View>
            <PillButton
              label={m.role === 'MANAGER' ? 'Manager' : 'Staff'}
              variant="soft"
              size="sm"
              style={{ marginRight: space.sm }}
              disabled={updateRole.isPending}
              onPress={() => updateRole.mutate({ id: m.id, role: m.role === 'MANAGER' ? 'STAFF' : 'MANAGER' })}
            />
            <Pressable onPress={() => setRemoving(m)} hitSlop={8}>
              <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                <Feather name="x" size={16} color={color.text.muted} />
              </View>
            </Pressable>
          </View>
        ))}
        {members.length === 0 && !staffQ.isLoading ? (
          <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
            No team members yet — add your manager or floor staff by phone.
          </T>
        ) : null}

        <InlineInput value={phone} onChangeText={setPhone} placeholder="+592 phone of an existing Swift account" keyboardType="phone-pad" />
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          <Chip label="Staff (orders only)" selected={role === 'STAFF'} onPress={() => setRole('STAFF')} style={{ height: 38, paddingHorizontal: space.md }} />
          <Chip label="Manager" selected={role === 'MANAGER'} onPress={() => setRole('MANAGER')} style={{ height: 38, paddingHorizontal: space.md }} />
        </View>
        {errMsg ? (
          <T variant="label" tone="error" style={{ marginTop: space.md }}>
            {errMsg}
          </T>
        ) : null}
        <PillButton
          label="Add to team"
          variant="soft"
          size="md"
          style={{ marginTop: space.md }}
          loading={addStaff.isPending}
          disabled={phone.trim().length < 10}
          onPress={submit}
        />
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
          Tap a role pill to switch Manager ↔ Staff.
        </T>
      </Card>

      <PopupCard visible={!!removing} onClose={() => setRemoving(null)}>
        <IconChip icon="user-x" size={56} tone="error" />
        <T variant="title" center style={{ marginTop: space.lg }}>
          Remove team member?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {removing?.user?.firstName ?? 'This person'} will lose store access immediately.
        </T>
        <PillButton
          label="Remove"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            const id = removing!.id;
            setRemoving(null);
            removeStaff.mutate(id);
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setRemoving(null)} />
      </PopupCard>
    </>
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
  // Staff & roles (§4.1): floor STAFF work the order queue — menu tools and
  // business insights are manager/owner surfaces (the API enforces the same).
  const { myRole } = useVendorProfile();
  const manager = myRole !== 'STAFF';
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
      {manager ? (
        <VTab.Screen
          name="Menu"
          component={MenuStackNav}
          options={{ tabBarLabel: 'Menu', tabBarIcon: ({ color: c, size }) => <Feather name="book-open" size={size} color={c} /> }}
        />
      ) : null}
      {manager ? (
        <VTab.Screen
          name="Insights"
          component={VendorInsightsScreen}
          options={{ tabBarLabel: 'Insights', tabBarIcon: ({ color: c, size }) => <Feather name="bar-chart-2" size={size} color={c} /> }}
        />
      ) : null}
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
      <Stack.Screen name="VendorOrderDetail" component={VendorOrderDetailScreen} />
      <Stack.Screen name="VendorOrderHistory" component={VendorOrderHistoryScreen} />
    </Stack.Navigator>
  );
}
