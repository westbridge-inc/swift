/** @jsxImportSource react */
import React, { useState, useEffect } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Pressable, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import { Image } from 'expo-image';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { SvgXml } from 'react-native-svg';
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  IconChip,
  LabeledInput,
  LinkText,
  LoadingBlock,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  SettingsRow,
  T,
  TonePill,
  DocketEdge,
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
import { VendorMyQrScreen } from './screens/VendorMyQrScreen';
import { VendorSwiftNumberScreen } from './screens/VendorSwiftNumberScreen';
import { DocumentChecklist } from '../../components/onboarding/DocumentChecklist';
import { PricingCard } from '../../components/onboarding/PricingCard';
import { MmgPayLinkCard } from '../../components/MmgPayLinkCard';
import { StandingCard } from '../../components/StandingCard';
import { API_URL, vendorApi } from '../../services/api';
import { openPayLink } from '../../lib/payLink';
import { useWentLive, WentLivePopup } from '../../components/onboarding/WentLive';
import { docLabel } from '../../components/onboarding/DocumentUploadCard';
import { useBecomePartner, useVerificationStatus } from '../../hooks/verification';
import {
  useVendorProfile,
  useVendorOrders,
  useVendorOrdersLive,
  useToggleOpen,
  useToggleOrders,
  useSetSelfDelivery,
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
  useVendorStanding,
  useVendorItemFeedback,
  useVendorSubscription,
  useVendorAnalytics,
  useVendorRevenue,
  useVendorOps,
  useVendorCashSettlements,
  useConfirmVendorCashSettlement,
  usePopularItems,
  useBusyHours,
  useRepeatCustomers,
  useVendorHours,
  useVendorBookings,
  useVendorBookingExceptions,
  useCreateBookingException,
  useDeleteBookingException,
  useSetHours,
  type DayHours,
  type VendorBooking,
  type VendorBookingException,
} from '../../hooks/vendorops';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../../stores/authStore';
import { track } from '../../lib/analytics';
import { useLocationStore } from '../../stores/locationStore';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { useVendorPreview } from '../../stores/vendorPreview';
import { RoleSwitcherSheet } from '../../components/RoleSwitcherSheet';
import { BillingStatusBlock } from '../../components/billing/BillingSurfaces';
import { money } from '../../lib/money';
import { vendorSurfaceForRole } from '../../lib/vendorRbac';
import { inventorySummary } from '../../lib/vendorInventory';
import { mediaUrl } from '../../lib/images';
import { VendorBulkImportScreen } from '../../screens/vendor/VendorBulkImportScreen';
import { NewOrderTakeover } from './NewOrderTakeover';

const Stack = createNativeStackNavigator();

const TYPES = [
  { key: 'RESTAURANT', label: 'Restaurant', icon: 'silverware-fork-knife' },
  { key: 'SUPERMARKET', label: 'Grocery', icon: 'basket-outline' },
  { key: 'STORE', label: 'Shop', icon: 'storefront-outline' },
  { key: 'SERVICE', label: 'Services', icon: 'tools' },
] as const;

// R1 type-awareness: the catalogue surface is named for the BUSINESS, not the
// kitchen. One map drives the tab label + icon, the menu-screen title, and the
// category prompt, so a Services vendor never sees "Menu"/"Mains, Drinks".
const CATALOGUE_META: Record<string, { label: string; icon: keyof typeof Feather.glyphMap; catPlaceholder: string }> = {
  RESTAURANT: { label: 'Menu', icon: 'book-open', catPlaceholder: 'e.g. Mains, Drinks' },
  SUPERMARKET: { label: 'Inventory', icon: 'package', catPlaceholder: 'e.g. Produce, Dairy, Household' },
  STORE: { label: 'Products', icon: 'tag', catPlaceholder: 'e.g. Apparel, Accessories' },
  SERVICE: { label: 'Services', icon: 'calendar', catPlaceholder: 'e.g. Haircuts, Nails, Spa' },
};
function catalogueMeta(vendorType?: string) {
  return CATALOGUE_META[vendorType ?? 'RESTAURANT'] ?? CATALOGUE_META['RESTAURANT']!;
}

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
  // [F-027-02] A store's coordinates are where customers are sent and where
  // dispatch measures from. This used to submit `latitude ?? 6.8013` — pinning
  // the shop at the Georgetown city centre whenever the device location was
  // unknown, while the caption below told the owner we had used their current
  // location. A fabricated pin AND a false statement about it. No location
  // now means no submission, said out loud.
  const hasPin = typeof latitude === 'number' && typeof longitude === 'number';
  const valid = hasPin && name.trim().length >= 2 && phone.trim().length >= 5 && addr.trim().length >= 3 && city.trim().length >= 2;

  const submit = () => {
    if (!hasPin) return; // guarded by `valid`, restated so the call site cannot fabricate
    become.mutate({
      role: 'VENDOR',
      business: {
        name: name.trim(),
        vendorType: type,
        phone: phone.trim(),
        addressLine1: addr.trim(),
        city: city.trim(),
        latitude,
        longitude,
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
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.lg, marginBottom: space.md }}>
          <BizValuePill icon="check-decagram" label="Keep 100%" />
          <BizValuePill icon="cash-remove" label="No commission" />
          <BizValuePill icon="calendar-check" label="Flat weekly fee" />
        </View>

        {/* The price on the door — what the flat weekly fee actually is. */}
        <PricingCard kind="vendor" />

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
          <T variant="caption" tone={hasPin ? 'muted' : 'error'}>
            {hasPin
              ? 'We\u2019ll use your current location as the store pin.'
              : 'We need your location to pin your store on the map \u2014 turn location on for Swift, then come back. Customers are sent to this pin.'}
          </T>
        </Card>

        {become.isError ? (
          <T variant="label" tone="error" style={{ marginTop: space.md }}>
            Couldn&apos;t create your store. Try again.
          </T>
        ) : null}
        <PillButton label="Create store" loading={become.isPending} disabled={!valid} style={{ marginTop: space.lg }} onPress={submit} />
        {/* The model line lives BELOW the work — the queue is the job. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.brand[50], paddingHorizontal: space.md, paddingVertical: space.sm, marginTop: space.md }}>
          <MaterialCommunityIcons name="check-decagram" size={15} color={color.success} />
          <T variant="caption" weight="semibold" tone="deep" style={{ flex: 1 }}>
            You keep 100% of every sale — Swift charges a flat weekly fee, never commission.
          </T>
        </View>
      </ScrollView>
    </Screen>
  );
}

function VendorOnboarding({ store, onPreview }: { store: any; onPreview: () => void }) {
  // Poll while onboarding so an approval reflects within seconds.
  const { data: status, isLoading, isError, refetch } = useVerificationStatus<any>(store.vendorType, undefined, { poll: true });
  return (
    <Screen>
      <TabHeader title={store.name} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        <PricingCard kind="vendor" />
        <DocumentChecklist role={store.vendorType} status={status} isLoading={isLoading} isError={isError} onRetry={refetch} />
        {/* Gated-trials spec §B: waiting shouldn't mean staring at a checklist.
            The dashboard is browsable in preview; selling stays locked. */}
        <PillButton label="Preview your dashboard" variant="soft" style={{ marginTop: space.lg }} onPress={onPreview} />
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
          Look around while you wait — selling unlocks the moment you&apos;re approved.
        </T>
      </ScrollView>
    </Screen>
  );
}

// Memoized: the live board re-renders on every socket event, but react-query's
// structural sharing keeps the SAME reference for orders that didn't change, so
// comparing `order` by reference re-renders only the card whose order actually
// moved — not the whole list (D6-MOB-03). The inline onAction/onOpen closures
// change each render but are equivalent for a given order id, so ignoring them
// is safe.
const VendorOrderCard = React.memo(function VendorOrderCard({
  order,
  onAction,
  onOpen,
  busy,
  showStore,
  docket,
}: {
  order: any;
  onAction: (action: VendorOrderActionKind) => void;
  onOpen?: () => void;
  busy: boolean;
  showStore?: boolean;
  /** Queue presentation: the card ends in the docket tear-line signature. */
  docket?: boolean;
}) {
  const actions = orderActions(order);
  const isMmg = order.paymentMethod === 'MOBILE_MONEY';
  const mmgPaid = order.paymentStatus === 'CAPTURED';
  const terminal = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'].includes((order.status || '').toUpperCase());
  const items = order.itemCount ?? order.items?.length ?? 0;
  const lines: any[] = order.items ?? [];
  const isPickup = order.fulfillment === 'PICKUP';
  const isAppt = order.fulfillment === 'APPOINTMENT';
  // A mobile service stores the customer's address (≠ the store's pickup address).
  const apptMobile = isAppt && !!order.deliveryAddress && order.deliveryAddress !== order.pickupAddress;
  return (
    <Pressable onPress={onOpen} disabled={!onOpen}>
      {({ pressed }) => (
    <View style={{ marginBottom: space.md, opacity: pressed && onOpen ? 0.88 : 1 }}>
    <Card style={docket ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : undefined}>
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
      {/* MMG direct-pay: the customer paid the store's own MMG. The vendor
          confirms they got it → the customer's screen flips to Paid. */}
      {isMmg ? (
        <View style={{ marginTop: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <MaterialCommunityIcons
              name={mmgPaid ? 'check-circle' : 'cellphone-check'}
              size={14}
              color={mmgPaid ? color.success : color.warning}
            />
            <T variant="label" weight="semibold" style={{ color: mmgPaid ? color.success : color.warning }}>
              {mmgPaid ? 'MMG payment received' : 'Awaiting MMG payment'}
            </T>
          </View>
          {!mmgPaid && !terminal ? (
            <PillButton
              label="Payment received"
              size="md"
              icon="check"
              style={{ marginTop: space.sm }}
              disabled={busy}
              onPress={() => onAction('confirm-payment')}
            />
          ) : null}
        </View>
      ) : null}
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
    {docket ? <DocketEdge inset={GUTTER} /> : null}
    </View>
      )}
    </Pressable>
  );
}, (prev, next) => prev.order === next.order && prev.busy === next.busy && prev.showStore === next.showStore && prev.docket === next.docket);

function VendorOps({ store, navigation }: any) {
  const toggleOpen = useToggleOpen();
  const toggleOrders = useToggleOrders();
  const setSelfDelivery = useSetSelfDelivery();
  const orderAction = useOrderAction();
  const ordersQ = useVendorOrders(true);
  const { stores, myRole } = useVendorProfile();
  // Client mirror of the server's vendor role guards: a STAFF board hides the
  // manager-only money + controls the API would 403 anyway (see vendorRbac). In
  // sample/pending preview myRole is OWNER, so the full owner view still shows.
  const surface = vendorSurfaceForRole(myRole);
  const analyticsQ = useVendorAnalytics(surface.canSeeMoney);
  // §B preview: the board renders for a not-yet-ACTIVE store (pending vendor) OR
  // for a prospective vendor walking a read-only SAMPLE dashboard (previewType).
  const previewType = useVendorPreview((s) => s.previewType);
  const inPreview = store.status !== 'ACTIVE' || !!previewType;
  const exitPreview = useVendorPreview((s) => s.exitPreview);
  const setPreviewType = useVendorPreview((s) => s.setPreviewType);
  const setPreviewIntent = useAuthStore((s) => s.setIntent);
  const cat = catalogueMeta(store.vendorType); // R1: name the catalogue per type
  // Only fetched to NAME the failing document in the suspension banner.
  const vstatus = useVerificationStatus<any>(store.vendorType);
  // §B5 progress: N of M checklist documents currently approved (unexpired).
  const checklist: string[] = vstatus.data?.checklist ?? [];
  const checklistTotal = checklist.length;
  const checklistApproved = checklist.filter((dt: string) =>
    (vstatus.data?.documents ?? []).some(
      (d: any) => d.docType === dt && d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date()),
    ),
  ).length;
  const failingDocs: string[] = store.isVerified === false
    ? (vstatus.data?.checklist ?? []).filter((dt: string) => {
        const docs = (vstatus.data?.documents ?? []).filter((d: any) => d.docType === dt);
        return !docs.some((d: any) => d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date()));
      })
    : [];
  const setSelectedStore = useStoreSwitcher((s) => s.setSelectedStore);
  const qc = useQueryClient();
  const switchStore = (id: string) => {
    setSelectedStore(id);
    qc.invalidateQueries({ queryKey: ['vendor'] });
  };
  const fetched: any[] = ordersQ.data ?? [];
  const open = !!store.isCurrentlyOpen;
  const accepting = !!store.acceptingOrders;
  const selfDelivery = !!store.selfDeliveryEnabled;
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
  // SWIFT-041: prefer the SERVER queueValue (aggregates the whole pending queue);
  // fall back to summing the loaded page only if the server hasn't provided it.
  const serverQueueValue = (analyticsQ.data as any)?.queueValue;
  const queueValue = typeof serverQueueValue === 'number'
    ? serverQueueValue
    : orders.reduce((sum, o) => sum + Number(o.totalAmount ?? o.total ?? 0), 0);
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

        {/* Gated-trials spec §B: a pending store browses in PREVIEW — encouraging
            copy with live progress (§B5), not the suspension scare. Tap returns
            to the checklist. */}
        {previewType ? (
          // Unauthenticated SAMPLE preview (R4): labelled read-only, with a
          // one-tap switch between the four business types so a prospective owner
          // sees how the dashboard reshapes to theirs.
          <View style={{ borderRadius: radius.lg, backgroundColor: color.brand[50], padding: space.md, marginBottom: space.lg, gap: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, flex: 1 }}>
                <Feather name="eye" size={15} color={color.brand[500]} />
                <T variant="label" tone="brand" weight="bold">Preview · sample data, read-only</T>
              </View>
              <Pressable
                testID="vendor-preview-exit"
                accessibilityRole="button"
                accessibilityLabel="Exit business preview"
                accessibilityHint="Return to the Swift role picker"
                onPress={() => { exitPreview(); setPreviewIntent(null); }}
                hitSlop={8}
              >
                <T variant="label" tone="brand" weight="bold">Exit</T>
              </Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }}>
              {TYPES.map((t) => (
                <Chip key={t.key} label={t.label} selected={previewType === t.key} onPress={() => setPreviewType(t.key)} style={{ height: 34, paddingHorizontal: space.md }} />
              ))}
            </ScrollView>
          </View>
        ) : inPreview ? (
          <Pressable onPress={exitPreview}>
            {({ pressed }) => (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.brand[50], padding: space.md, marginBottom: space.lg, opacity: pressed ? 0.85 : 1 }}>
                <Feather name="eye" size={15} color={color.brand[500]} style={{ marginTop: 1 }} />
                <View style={{ flex: 1 }}>
                  <T variant="label" tone="brand" weight="bold">
                    {checklistTotal > 0
                      ? `Finish verification to start earning — ${checklistApproved} of ${checklistTotal} documents approved.`
                      : 'Finish verification to start earning.'}
                  </T>
                  <T variant="caption" tone="brand" style={{ marginTop: 2 }}>
                    You&apos;re in preview: selling unlocks the moment you&apos;re approved. Tap to track your verification.
                  </T>
                </View>
              </View>
            )}
          </Pressable>
        ) : null}

        {/* Verification suspension — commerce is off until documents are renewed.
            Only a store that has BEEN live can be suspended; pending stores get
            the preview banner above instead. */}
        {!inPreview && store.isVerified === false ? (
          <Pressable onPress={() => navigation?.navigate?.('Account')}>
            {({ pressed }) => (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.soft.danger, padding: space.md, marginBottom: space.lg, opacity: pressed ? 0.85 : 1 }}>
                <Feather name="alert-circle" size={15} color={color.error} style={{ marginTop: 1 }} />
                <T variant="label" tone="error" style={{ flex: 1 }}>
                  {failingDocs.length > 0
                    ? `Store suspended — ${failingDocs.map((d) => docLabel(d)).join(', ')} ${failingDocs.length === 1 ? 'needs' : 'need'} renewal, so new orders are off. Tap to fix it under Account.`
                    : 'Store suspended — a required document is missing or expired, so new orders are off. Tap to renew it under Account.'}
                </T>
              </View>
            )}
          </Pressable>
        ) : null}

        {/* [design-100x Flow-13] THE SHIFT STRIP — one sunken band that answers
            the operator's first three questions (how's today · am I open ·
            what's waiting) before anything else. Money is MANAGER-only (the
            /analytics read 403s STAFF). */}
        <View
          style={{
            borderRadius: radius.lg,
            backgroundColor: color.surface.sunken,
            padding: space.lg,
            marginBottom: space.lg,
            flexDirection: 'row',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
          }}
        >
          <View style={{ flex: 1, paddingRight: space.md }}>
            <T variant="micro" tone="muted">TODAY</T>
            {surface.canSeeMoney ? (
              <T variant="numL" style={{ marginTop: 2 }}>{money(today.revenue ?? 0)}</T>
            ) : (
              <T variant="numL" style={{ marginTop: 2 }}>{String(orders.length)}</T>
            )}
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {surface.canSeeMoney
                ? `${today.orders ?? 0} order${(today.orders ?? 0) === 1 ? '' : 's'} today`
                : 'orders on the board'}
            </T>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: !inPreview && open && accepting ? color.success : color.text.muted }} />
              <T variant="label" weight="bold">
                {inPreview ? 'Preview' : !open ? 'Closed' : accepting ? 'Open' : 'Paused'}
              </T>
            </View>
            <T variant="caption" tone="muted">
              {orders.length} active{surface.canSeeMoney ? ` · ${money(queueValue)} in queue` : ''}
            </T>
          </View>
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
              docket
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
                docket
                busy={busy}
                onAction={(action) => orderAction.mutate({ id: o.id, action })}
                onOpen={() => navigation.navigate('VendorOrderDetail', { orderId: o.id, orderNumber: o.orderNumber })}
              />
            ))}
          </>
        ) : null}
        {/* Store status. In §B preview the controls are honestly locked — the
            server refuses commerce-on for an unverified business anyway. */}
        <Card style={{ marginBottom: space.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: !inPreview && open && accepting ? color.success : color.text.muted }} />
                <T variant="body" weight="bold">
                  {inPreview ? 'Not open yet' : !open ? 'Store closed' : accepting ? 'Open for orders' : 'Orders paused'}
                </T>
              </View>
              <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                {inPreview
                  ? 'Your store opens for orders once verification is approved.'
                  : !open ? 'Outside business hours' : accepting ? 'Accepting new orders' : 'You’re open but not taking new orders'}
              </T>
            </View>
            {/* Open/close is MANAGER-only server-side; STAFF still get the
                pause/resume pill below (toggle-orders is open to floor staff). */}
            {surface.canToggleOpen ? (
              <BrandSwitch value={!inPreview && open} disabled={inPreview} onChange={() => (inPreview || toggleOpen.isPending ? undefined : toggleOpen.mutate())} />
            ) : null}
          </View>
          {!inPreview ? (
            <PillButton
              label={accepting ? 'Pause new orders' : 'Resume orders'}
              variant="soft"
              size="md"
              style={{ marginTop: space.md }}
              loading={toggleOrders.isPending}
              onPress={() => toggleOrders.mutate()}
            />
          ) : null}
          {toggleOrders.isError ? (
            <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
              {(toggleOrders.error as any)?.response?.data?.error?.message ?? 'Couldn’t update — try again.'}
            </T>
          ) : null}
        </Card>

        {/* Who delivers — self-delivery vs a Swift rider. When on, the server
            routes this store's delivery orders to the vendor (no rider sent).
            MANAGER-only setting, so STAFF don't see a control that would 403. */}
        {!inPreview && surface.canSetSelfDelivery ? (
          <Card style={{ marginBottom: space.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: space.md }}>
                <T variant="body" weight="bold">
                  Deliver my own orders
                </T>
                <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                  {selfDelivery
                    ? 'You deliver your orders yourself — Swift won’t send a rider.'
                    : 'Swift sends the nearest rider for your delivery orders.'}
                </T>
              </View>
              <BrandSwitch
                value={selfDelivery}
                disabled={setSelfDelivery.isPending}
                onChange={() => (setSelfDelivery.isPending ? undefined : setSelfDelivery.mutate(!selfDelivery))}
              />
            </View>
            {setSelfDelivery.isError ? (
              <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
                Couldn’t update — try again.
              </T>
            ) : null}
          </Card>
        ) : null}

        {/* The Menu tab isn't registered for STAFF — don't show a door that goes nowhere. */}
        <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.xl }}>
          {myRole !== 'STAFF' ? (
            <PillButton label={`Manage ${cat.label.toLowerCase()}`} variant="outline" size="md" style={{ flex: 1 }} onPress={() => navigation.navigate('Menu')} />
          ) : null}
          <PillButton label="Order history" variant="outline" size="md" style={{ flex: 1 }} onPress={() => navigation.navigate('VendorOrderHistory')} />
        </View>

      </ScrollView>
    </Screen>
  );
}

function VendorRoot() {
  const { store, stores, isLoading } = useVendorProfile();
  const selectedStoreId = useStoreSwitcher((s) => s.selectedStoreId);
  const setSelectedStore = useStoreSwitcher((s) => s.setSelectedStore);
  const { preview, previewType, enterPreview, exitPreview } = useVendorPreview();
  // Preview is a per-store choice: switching stores lands on that store's
  // real state (checklist for pending, board for live) — never a stale peek.
  // BUT the unauthenticated sample preview (previewType set) has one synthetic
  // store; don't tear it down on its own mount.
  useEffect(() => {
    if (!previewType) exitPreview();
  }, [store?.id, exitPreview, previewType]);
  // Live order feed for the selected store, on every tab — new orders land
  // instantly (socket) with the 12s poll as fallback.
  const { takeover, dismissTakeover } = useVendorOrdersLive(store && store.status === 'ACTIVE' ? store.id : undefined);
  // The approval moment gets its moment (observed PENDING → ACTIVE flip only).
  const live = useWentLive(store ? store.status === 'ACTIVE' : undefined);

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
  return (
    <>
      {store.status !== 'ACTIVE' && !preview ? (
        <VendorOnboarding store={store} onPreview={enterPreview} />
      ) : (
        <VendorTabs />
      )}
      <WentLivePopup visible={live.celebrate} onClose={live.dismiss} kind="vendor" />
      {/* Alerts spec §A1: the NEW-ORDER takeover sits above every tab. */}
      {takeover.length > 0 ? <NewOrderTakeover queue={takeover} onDismiss={dismissTakeover} /> : null}
    </>
  );
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
  const readOnly = !!useVendorPreview((state) => state.previewType);
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
        <Pressable
          disabled={readOnly}
          onPress={() => (setAvail.isPending ? undefined : setAvail.mutate({ id: item.id, isAvailable: !available }))}
          hitSlop={6}
        >
          {({ pressed }) => (
            <View
              style={{
                borderRadius: 9999,
                paddingHorizontal: space.md,
                paddingVertical: 5,
                backgroundColor: available ? color.soft.success : color.surface.base,
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
        <PillButton label="Delete" variant="outline" size="sm" style={{ flex: 1 }} loading={del.isPending} disabled={readOnly} onPress={() => setConfirmDelete(true)} />
      </View>

      <PopupCard visible={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Delete item?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Remove &quot;{item.name}&quot; from your menu.
        </T>
        <PillButton
          label="Delete"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            if (readOnly) return;
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
  const readOnly = !!useVendorPreview((state) => state.previewType);
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
    if (readOnly) return;
    const name = groupName.trim();
    if (!name || addGroup.isPending) return;
    const owner = requireAuthSessionSnapshot();
    const g = await addGroup.mutateAsync({
      itemId: item.id,
      data: { name, isRequired: groupRequired, minSelect: groupRequired ? 1 : 0, maxSelect: groupMulti ? 10 : 1 },
      authSession: owner,
    });
    requireAuthSessionForPrincipal(owner);
    setGroups((gs) => [...gs, { options: [], ...g }]);
    setGroupName('');
    setGroupRequired(false);
    setGroupMulti(false);
  };

  const submitOption = async (groupId: string) => {
    if (readOnly) return;
    const d = draft(groupId);
    const name = d.name.trim();
    if (!name || addOption.isPending) return;
    const owner = requireAuthSessionSnapshot();
    const opt = await addOption.mutateAsync({
      groupId,
      data: { name, additionalPrice: Number(d.price) || 0 },
      authSession: owner,
    });
    requireAuthSessionForPrincipal(owner);
    setGroups((gs) => gs.map((g) => (g.id === groupId ? { ...g, options: [...(g.options ?? []), opt] } : g)));
    setDrafts((s) => ({ ...s, [groupId]: { name: '', price: '' } }));
  };

  const removeOption = (groupId: string, optionId: string) => {
    if (readOnly) return;
    const owner = requireAuthSessionSnapshot();
    delOption.mutate({ id: optionId, authSession: owner }, {
      onSuccess: () => {
        try {
          requireAuthSessionForPrincipal(owner);
          setGroups((gs) =>
            gs.map((g) => (g.id === groupId ? { ...g, options: (g.options ?? []).filter((o: any) => o.id !== optionId) } : g)),
          );
        } catch {
          // The editor belongs to an older account and is being unmounted.
        }
      },
    });
  };

  return (
    <Card style={{ marginTop: space.lg }}>
      <T variant="heading">Options &amp; add-ons</T>
      <T variant="label" tone="muted" style={{ marginTop: 4 }}>
        Sizes, toppings, extras — customers pick these when ordering.
      </T>
      {readOnly ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
          Read-only in the sample preview.
        </T>
      ) : null}

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
            <Pressable disabled={readOnly} onPress={() => setRemoveGroupId(g.id)} hitSlop={8}>
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
              <Pressable disabled={readOnly} onPress={() => removeOption(g.id, o.id)} hitSlop={8}>
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
            <Pressable onPress={() => submitOption(g.id)} disabled={readOnly || addOption.isPending}>
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
          disabled={readOnly || !groupName.trim()}
          onPress={submitGroup}
        />
      </View>

      <PopupCard visible={!!removeGroupId} onClose={() => setRemoveGroupId(null)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Remove group?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Delete this option group and all its choices.
        </T>
        <PillButton
          label="Delete"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            if (readOnly) return;
            const gid = removeGroupId!;
            setRemoveGroupId(null);
            const owner = requireAuthSessionSnapshot();
            delGroup.mutate({ id: gid, authSession: owner }, {
              onSuccess: () => {
                try {
                  requireAuthSessionForPrincipal(owner);
                  setGroups((gs) => gs.filter((g) => g.id !== gid));
                } catch {
                  // The editor belongs to an older account and is being unmounted.
                }
              },
            });
          }}
        />
        <PillButton label="Cancel" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setRemoveGroupId(null)} />
      </PopupCard>
    </Card>
  );
}

/** §5.6 reasoned stock movement — the audit-trail path, not a raw overwrite:
 *  ±delta with a reason (received / damaged / manual / reconcile / return). */
function StockAdjustRow({ item }: { item: any }) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN'>('RECEIVED');
  const adjust = useMutation({
    mutationFn: () => vendorApi.adjustStock(item.id, { delta: Number(delta), reason }),
    onSuccess: () => {
      setOpen(false);
      setDelta('');
      qc.invalidateQueries({ queryKey: ['vendor', 'menu'] });
    },
  });
  const n = Number(delta);
  const valid = delta.trim() !== '' && Number.isInteger(n) && n !== 0;

  if (!open) {
    if (readOnly) {
      return (
        <T variant="caption" tone="muted">
          Stock adjustment is read-only in preview.
        </T>
      );
    }
    return (
      <Pressable onPress={() => setOpen(true)} hitSlop={6}>
        <T variant="caption" weight="semibold" tone="brand">
          Adjust stock (received / damaged)…
        </T>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      <InlineInput value={delta} onChangeText={setDelta} placeholder="+50 received, -3 damaged" keyboardType="default" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {(['RECEIVED', 'DAMAGED', 'MANUAL', 'RECONCILE', 'RETURN'] as const).map((r) => (
          <Chip key={r} label={r.toLowerCase()} selected={reason === r} onPress={() => setReason(r)} style={{ height: 32, paddingHorizontal: space.md }} />
        ))}
      </View>
      {adjust.isError ? (
        <T variant="caption" tone="error">
          {((adjust.error as any)?.response?.data?.error?.message) ?? 'Adjustment failed.'}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <PillButton label="Apply" size="sm" style={{ flex: 1 }} loading={adjust.isPending} disabled={readOnly || !valid || adjust.isPending} onPress={() => adjust.mutate()} />
        <PillButton label="Cancel" variant="soft" size="sm" style={{ flex: 1 }} onPress={() => setOpen(false)} />
      </View>
    </View>
  );
}

/** Stock alerts from the fetched menu itself: tracked items at/below their
 *  own alert level (or sold out and auto-hidden). */
// Inventory-first lead for goods vendors (grocery/shop): an at-a-glance stock
// health read above the catalogue. Data-driven — self-hides when nothing tracks
// stock, so restaurants/services (null stock) never see it.
function InventorySummaryCard({ categories }: { categories: any[] }) {
  const s = inventorySummary(categories);
  if (s.tracked === 0) return null;
  const cells: { label: string; value: number; tone: 'ink' | 'deep' | 'error' | 'muted' }[] = [
    { label: 'In stock', value: s.inStock, tone: 'ink' },
    { label: 'Low', value: s.lowStock, tone: s.lowStock > 0 ? 'deep' : 'muted' },
    { label: 'Out', value: s.outOfStock, tone: s.outOfStock > 0 ? 'error' : 'muted' },
    { label: 'SKUs', value: s.tracked, tone: 'muted' },
  ];
  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1, marginBottom: space.sm }}>
        INVENTORY
      </T>
      <View style={{ flexDirection: 'row' }}>
        {cells.map((c) => (
          <View key={c.label} style={{ flex: 1 }}>
            <T variant="heading" tone={c.tone}>
              {String(c.value)}
            </T>
            <T variant="caption" tone="muted">
              {c.label}
            </T>
          </View>
        ))}
      </View>
    </Card>
  );
}

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
    <View style={{ borderRadius: radius.lg, backgroundColor: color.soft.warning, padding: space.lg, marginBottom: space.lg }}>
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
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>(cat.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const itemCount = (cat.items ?? []).length;

  const saveName = () => {
    if (readOnly) return;
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
      <Pressable disabled={readOnly} onPress={() => setEditing(true)} hitSlop={6}>
        {({ pressed }) => (
          <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
            <Feather name="edit-2" size={16} color={color.text.muted} />
          </View>
        )}
      </Pressable>
      <Pressable disabled={readOnly} onPress={() => setConfirmDelete(true)} hitSlop={6}>
        {({ pressed }) => (
          <View style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
            <Feather name="trash-2" size={16} color={color.text.muted} />
          </View>
        )}
      </Pressable>

      <PopupCard visible={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <IconChip icon="trash-2" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Delete “{cat.name}”?
        </PopupTitle>
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
            if (readOnly) return;
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
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const menuQ = useVendorMenu();
  const createCategory = useCreateCategory();
  const { store } = useVendorProfile();
  const cat = catalogueMeta(store?.vendorType); // R1: title + prompts named for the type
  const [newCat, setNewCat] = useState('');
  const categories: any[] = menuQ.data ?? [];
  const catOptions = categories.map((c) => ({ id: c.id, name: c.name }));

  const addCategory = () => {
    if (readOnly) return;
    const name = newCat.trim();
    if (name.length < 1) return;
    createCategory.mutate({ name }, { onSuccess: () => setNewCat('') });
  };

  return (
    <Screen>
      <SubHeader
        title={cat.label}
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
          {/* Inventory-first: goods vendors lead with stock health (self-hides
              for restaurants/services, which don't track stock). */}
          <InventorySummaryCard categories={categories} />
          <Card style={{ marginBottom: space.md }}>
            <T variant="label" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
              New category
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <InlineInput style={{ flex: 1 }} value={newCat} onChangeText={setNewCat} placeholder={cat.catPlaceholder} />
              <PillButton label="Add" size="md" loading={createCategory.isPending} disabled={readOnly || newCat.trim().length < 1} onPress={addCategory} />
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
  const readOnly = !!useVendorPreview((state) => state.previewType);
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
    if (readOnly || !valid || busy) return;
    const owner = requireAuthSessionSnapshot();
    const operationStoreId = useStoreSwitcher.getState().selectedStoreId;
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
      authSession: owner,
      storeId: operationStoreId,
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
    let current = requireAuthSessionForPrincipal(owner);
    const itemId = existing?.id ?? saved?.id;
    if (localPhoto && itemId) {
      // Item is already saved; a failed photo upload shouldn't block the flow.
      try {
        await uploadImage.mutateAsync({
          id: itemId,
          file: localPhoto,
          authSession: current,
          storeId: operationStoreId,
        });
      } catch (uploadError) {
        if (uploadError instanceof AuthSessionBoundaryError) throw uploadError;
        // The item itself is durable; the vendor can retry only the photo.
      }
      current = requireAuthSessionForPrincipal(owner);
    }
    requireAuthSessionForPrincipal(current);
    navigation.goBack();
  };

  return (
    <Screen>
      <SubHeader title={existing ? 'Edit Item' : 'New Item'} navigation={navigation} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Photo */}
        <Pressable disabled={readOnly} onPress={() => setPhotoMenu(true)}>
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
            {readOnly ? (
              <T variant="caption" tone="muted">Read-only sample photo</T>
            ) : (
              <LinkText label={uploadImage.isPending ? 'Uploading…' : 'Change photo'} onPress={() => setPhotoMenu(true)} />
            )}
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
              {/* Reasoned movements (received/damaged/…) keep an audit trail —
                  different from overwriting the number above. */}
              {existing && existing.stockQuantity != null ? (
                <StockAdjustRow item={existing} />
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
        <PillButton
          label={readOnly ? 'Read-only preview' : existing ? 'Save changes' : 'Add item'}
          loading={busy}
          disabled={readOnly || !valid}
          onPress={submit}
        />
      </ScrollView>

      {/* Photo source picker — kit popup */}
      <PopupCard visible={photoMenu} onClose={() => setPhotoMenu(false)}>
        <IconChip icon="camera" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Item photo
        </PopupTitle>
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

/** Movement R9 — Standing module + item-thumbs Pareto (daily-folded, RAT-G). */
function VendorStandingSection() {
  const standingQ = useVendorStanding();
  const thumbsQ = useVendorItemFeedback();
  const flagged = ((thumbsQ.data ?? []) as Array<{ itemId: string; name: string; up: number; down: number }>)
    .filter((r) => r.down > 0)
    .slice(0, 5);
  return (
    <>
      {standingQ.data ? <StandingCard data={standingQ.data} title="Store standing" /> : null}
      {flagged.length > 0 ? (
        <Card style={{ marginBottom: space.md }}>
          <T variant="label" weight="semibold">
            Item feedback — last 30 days
          </T>
          <View style={{ marginTop: space.sm, gap: 4 }}>
            {flagged.map((r) => (
              <View key={r.itemId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T variant="caption" numberOfLines={1} style={{ flex: 1 }}>
                  {r.name}
                </T>
                <T variant="caption" tone="muted">
                  👎 {r.down}
                  {r.up > 0 ? `  ·  👍 ${r.up}` : ''}
                </T>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
    </>
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

/** MMG orders: the customer's payment (delivery fee included) landed in the
 *  store's MMG wallet — so the store hands the rider their fee in cash. This
 *  card is that ledger; "Mark paid" is the store's half of the dual confirm. */
function RiderFeesOwedCard() {
  const q = useVendorCashSettlements();
  const confirm = useConfirmVendorCashSettlement();
  const rows: any[] = q.data?.unsettled ?? [];
  if (rows.length === 0) return null;
  return (
    <Card style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
          YOU OWE RIDERS
        </T>
        <T variant="label" weight="bold">
          {money(q.data?.summary?.owed ?? 0)}
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
        MMG orders — the delivery fee came to you with the customer&apos;s payment. Hand it to the rider in cash (usually at pickup).
      </T>
      {rows.map((r) => (
        <View key={r.id} style={{ paddingTop: space.md, marginTop: space.md, borderTopWidth: 1, borderTopColor: color.border.subtle }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T variant="label" weight="semibold" numberOfLines={1}>
                {r.rider?.name || 'Rider'}
              </T>
              <T variant="caption" tone="muted">
                {r.orderNumber ? `#${r.orderNumber} · ` : ''}{fmtDate(r.createdAt)}
              </T>
            </View>
            <T variant="label" weight="bold" style={{ marginLeft: space.md }}>
              {money(r.amount)}
            </T>
          </View>
          {r.status === 'STORE_CONFIRMED' ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              You marked this paid — waiting for the rider to confirm.
            </T>
          ) : (
            <>
              {r.status === 'RIDER_CONFIRMED' ? (
                <T variant="caption" weight="semibold" tone="deep" style={{ marginTop: space.sm }}>
                  The rider confirmed receiving it — mark it paid to close it out.
                </T>
              ) : null}
              <PillButton
                label="Mark paid"
                variant="soft"
                size="sm"
                style={{ alignSelf: 'flex-start', marginTop: space.sm }}
                loading={confirm.isPending && confirm.variables === r.id}
                disabled={confirm.isPending}
                onPress={() => confirm.mutate(r.id)}
              />
            </>
          )}
        </View>
      ))}
    </Card>
  );
}

// Loyalty at a glance — how many customers came back (>=2 finished orders) and
// the repeat rate. Reads the MANAGER-only endpoint; the Insights tab is already
// manager-gated. Stays hidden until the store has finished orders.
function RepeatCustomersCard() {
  const q = useRepeatCustomers();
  const d: any = q.data;
  if (!d || (d.totalCustomers ?? 0) === 0) return null;
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <MaterialCommunityIcons name="account-heart" size={18} color={color.brand[500]} />
          <T variant="body" weight="semibold">
            Repeat customers
          </T>
        </View>
        <T variant="body" weight="bold" tone="brand">
          {d.repeatRate ?? 0}%
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {d.repeatCustomers ?? 0} of {d.totalCustomers} customers came back — {d.totalOrders ?? 0} finished order{(d.totalOrders ?? 0) === 1 ? '' : 's'}.
      </T>
    </Card>
  );
}

function VendorInsightsScreen() {
  const q = useVendorAnalytics();
  // Signed short-lived link (the JWT can't ride an in-app browser).
  const statement = useMutation({
    mutationFn: async () => {
      const owner = requireAuthSessionSnapshot();
      const r = await vendorApi.salesStatement(owner);
      requireAuthSessionForPrincipal(owner);
      const path = r.data?.data?.path as string;
      if (path) await openPayLink(`${API_URL}${path}`);
      requireAuthSessionForPrincipal(owner);
    },
  });
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

            {/* MMG cash ledger — delivery fees owed to riders (renders only when non-empty) */}
            <RiderFeesOwedCard />

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
            <RepeatCustomersCard />
            <VendorStandingSection />
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

            {/* Printable 30-day sales statement (marketplace §12) — what a
                store shows their accountant. Opens in the in-app browser. */}
            <PillButton
              label="Get sales statement"
              variant="outline"
              size="md"
              style={{ marginTop: space.lg }}
              loading={statement.isPending}
              onPress={() => statement.mutate()}
            />
            {statement.isError ? (
              <T variant="caption" tone="error" center style={{ marginTop: space.sm }}>
                Couldn’t open the statement — try again.
              </T>
            ) : null}
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
  const qc = useQueryClient();
  const saveMmgLink = useMutation({
    mutationFn: (mmgPayUrl: string | null) => vendorApi.updateProfile({ mmgPayUrl }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }),
  });

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

        {isManager ? (
          <MmgPayLinkCard
            who="store"
            value={store?.mmgPayUrl}
            saving={saveMmgLink.isPending}
            onSave={(u) => saveMmgLink.mutate(u)}
          />
        ) : null}

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
                            style={{ fontFamily: 'Hanken', fontSize: 13, color: color.text.primary, textAlign: 'center', paddingVertical: 8 }}
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
                            style={{ fontFamily: 'Hanken', fontSize: 13, color: color.text.primary, textAlign: 'center', paddingVertical: 8 }}
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
  const navigation = useNavigation<any>();
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
        : // Dual-display law (USD ③): server-composed when USD pricing is on.
          (sub.usdDisplay?.line ??
            `${money(sub.customRate ?? sub.weeklyRate)}/week${sub.nextBillingDate ? ` · next bill ${fmtDate(sub.nextBillingDate)}` : ''}`);
  return (
    <>
      <Card style={{ marginBottom: space.lg, paddingVertical: space.sm }}>
        <SettingsRow icon="credit-card" label="Subscription" sub={subLine} right={<TonePill label={pill.label} tone={pill.tone} />} />
        <SettingsRow
          icon="hash"
          label="My Swift Number"
          sub="Pay the weekly fee at any MMG agent"
          onPress={() => navigation.navigate('VendorMySwiftNumber')}
        />
        {phone ? <SettingsRow icon="phone" label="Phone" right={<T variant="label" tone="muted">{phone}</T>} /> : null}
      </Card>
      {/* Honest billing status — wallet balance, grace deadline, or the paused
          block. Silent on a healthy account (the row above is the way in). */}
      <BillingStatusBlock
        sub={sub}
        onPay={() => navigation.navigate('VendorMySwiftNumber')}
        compact
        style={{ marginTop: 0, marginBottom: space.lg }}
      />
    </>
  );
}

/** Storefront QR (real /vendor/qr payload) — the entry point into the full
 *  "My Swift QR" screen (share, performance, lifecycle). */
function StoreQrCard() {
  const qrQ = useVendorQr();
  const navigation = useNavigation<any>();
  if (!qrQ.data?.svg) return null;
  return (
    <Pressable onPress={() => navigation.navigate('VendorMyQr')} accessibilityRole="button" accessibilityLabel="Open My Swift QR">
      {({ pressed }) => (
        <Card style={{ alignItems: 'center', marginBottom: space.lg, opacity: pressed ? 0.85 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', justifyContent: 'space-between' }}>
            <T variant="body" weight="semibold">
              My Swift QR
            </T>
            <Feather name="chevron-right" size={18} color={color.text.muted} />
          </View>
          <View style={{ padding: space.md, borderRadius: radius.lg, backgroundColor: color.white, marginTop: space.md }}>
            <SvgXml xml={qrQ.data.svg} width={168} height={168} />
          </View>
          <T variant="caption" weight="semibold" tone="brand" style={{ marginTop: space.md }}>
            {qrQ.data.deepLink}
          </T>
          <T variant="caption" tone="muted" center style={{ marginTop: 4 }}>
            Customers scan this to order from you — tap to share, print and see scans.
          </T>
        </Card>
      )}
    </Pressable>
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
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Remove team member?
        </PopupTitle>
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

/** Slot instants carry LOCAL wall-clock time on their UTC face (the booking
 *  convention, same as the customer picker) — format in UTC or a UTC-4 phone
 *  shows a 9:00 appointment as 5:00 (found live, SCH-F). */
function fmtClock(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

function AppointmentCard({ b }: { b: VendorBooking }) {
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm }}>
      <View style={{ alignItems: 'center', minWidth: 60 }}>
        <T variant="body" weight="bold">{fmtClock(b.slotStart)}</T>
        <T variant="caption" tone="muted">{fmtClock(b.slotEnd)}</T>
      </View>
      <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: color.border.subtle }} />
      <View style={{ flex: 1 }}>
        <T variant="body" weight="semibold" numberOfLines={1}>{b.serviceName}</T>
        <T variant="caption" tone="muted" numberOfLines={1}>
          {b.customer?.firstName ?? 'Customer'}{b.price ? ` · ${money(b.price)}` : ''}
        </T>
      </View>
      <TonePill tone={b.status === 'CONFIRMED' ? 'success' : 'neutral'} label={b.status === 'CONFIRMED' ? 'Confirmed' : 'Reserved'} />
    </Card>
  );
}

/** UTC-face day key — matches the booking convention end to end. */
function dayKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** The provider's DAY CALENDAR (scheduling spec 2.2): 7-day strip → the
 *  chosen day's timeline — booked slots as cards, blocked time as quiet
 *  hatched rows with one-tap unblock — plus "Block time" (full day or a
 *  window, two taps for a funeral afternoon). Fed by GET /vendor/bookings +
 *  /vendor/bookings/exceptions; the socket nudge refetches instantly. */
function VendorScheduleScreen({ navigation }: any) {
  const q = useVendorBookings();
  const exceptionsQ = useVendorBookingExceptions();
  const createBlock = useCreateBookingException();
  const deleteBlock = useDeleteBookingException();
  const [dayKey, setDayKey] = useState(() => dayKeyOf(new Date()));
  const [blocking, setBlocking] = useState(false);
  const [fullDay, setFullDay] = useState(true);
  const [blockStart, setBlockStart] = useState('13:00');
  const [blockEnd, setBlockEnd] = useState('17:00');
  const [blockReason, setBlockReason] = useState('');

  const rows: VendorBooking[] = q.data ?? [];
  const exceptions: VendorBookingException[] = exceptionsQ.data ?? [];

  // The strip: today + 6, on the UTC face like every slot instant.
  const strip = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
    return {
      key: dayKeyOf(d),
      label: i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
    };
  });
  const dayBookings = rows.filter((b) => dayKeyOf(new Date(b.slotStart)) === dayKey);
  const dayBlocks = exceptions.filter((e) => dayKeyOf(new Date(e.date)) === dayKey);
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const blockValid = fullDay || (HHMM.test(blockStart) && HHMM.test(blockEnd) && blockStart < blockEnd);

  const submitBlock = () => {
    createBlock.mutate(
      {
        date: dayKey,
        ...(fullDay ? {} : { start: blockStart, end: blockEnd }),
        ...(blockReason.trim() ? { reason: blockReason.trim() } : {}),
      },
      { onSettled: () => setBlocking(false) },
    );
  };

  return (
    <Screen>
      <SubHeader title="Schedule" navigation={navigation} hideBack action={{ label: 'Block time', onPress: () => setBlocking(true) }} />
      <View style={{ paddingHorizontal: GUTTER, marginBottom: space.md }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {strip.map((d) => (
            <Chip key={d.key} label={d.label} selected={d.key === dayKey} onPress={() => setDayKey(d.key)} />
          ))}
        </ScrollView>
      </View>
      {q.isLoading || exceptionsQ.isLoading ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorState message="We couldn't load your schedule. Check your connection and try again." onRetry={() => q.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
          {dayBlocks.map((e) => (
            <Card
              key={e.id}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm,
                backgroundColor: color.surface.sunken, borderWidth: 1, borderColor: color.border.subtle,
              }}
            >
              <Feather name="slash" size={16} color={color.text.muted} />
              <View style={{ flex: 1 }}>
                <T variant="body" weight="semibold">
                  {e.start ? `Blocked · ${e.start}–${e.end}` : 'Blocked · all day'}
                </T>
                {e.reason ? (
                  <T variant="caption" tone="muted" numberOfLines={1}>
                    {e.reason}
                  </T>
                ) : null}
              </View>
              <Pressable onPress={() => deleteBlock.mutate(e.id)} hitSlop={10} accessibilityLabel="Remove block">
                {({ pressed }) => <Feather name="x" size={18} color={color.text.muted} style={{ opacity: pressed ? 0.5 : 1 }} />}
              </Pressable>
            </Card>
          ))}
          {dayBookings.length === 0 && dayBlocks.length === 0 ? (
            <EmptyState
              icon="calendar"
              title="No bookings this day"
              body="Your open hours are visible to customers — reservations land here."
            />
          ) : (
            dayBookings.map((b) => <AppointmentCard key={b.id} b={b} />)
          )}
        </ScrollView>
      )}

      {/* Block time — two taps for a funeral afternoon. */}
      <PopupCard visible={blocking} onClose={() => setBlocking(false)}>
        <PopupTitle variant="body" weight="bold" center>
          Block time
        </PopupTitle>
        <T variant="caption" tone="muted" center style={{ marginTop: space.xs, marginBottom: space.lg }}>
          Customers won't see these slots. Nothing is shown as a reason.
        </T>
        <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md }}>
          <T variant="body">All day</T>
          <BrandSwitch value={fullDay} onChange={setFullDay} />
        </View>
        {!fullDay ? (
          <View style={{ alignSelf: 'stretch', flexDirection: 'row', gap: space.md, marginBottom: space.md }}>
            <View style={{ flex: 1 }}>
              <LabeledInput label="From" value={blockStart} onChangeText={setBlockStart} placeholder="13:00" />
            </View>
            <View style={{ flex: 1 }}>
              <LabeledInput label="Until" value={blockEnd} onChangeText={setBlockEnd} placeholder="17:00" />
            </View>
          </View>
        ) : null}
        <View style={{ alignSelf: 'stretch', marginBottom: space.lg }}>
          <LabeledInput label="Note (only you see this)" value={blockReason} onChangeText={setBlockReason} placeholder="Optional" />
        </View>
        <PillButton
          label="Block time"
          disabled={!blockValid}
          loading={createBlock.isPending}
          onPress={submitBlock}
          style={{ alignSelf: 'stretch', marginBottom: space.md }}
        />
        <LinkText label="Cancel" tone="muted" onPress={() => setBlocking(false)} />
      </PopupCard>
    </Screen>
  );
}

const VTab = createBottomTabNavigator();

function VendorTabs() {
  // Staff & roles (§4.1): floor STAFF work the order queue — menu tools and
  // business insights are manager/owner surfaces (the API enforces the same).
  const { myRole, store } = useVendorProfile();
  const manager = myRole !== 'STAFF';
  const cat = catalogueMeta(store?.vendorType); // R1: the catalogue tab is named for the type
  const isService = store?.vendorType === 'SERVICE';
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
      {isService ? (
        // R1: a Services store runs its day from a booking agenda, not the queue.
        <VTab.Screen
          name="Schedule"
          component={VendorScheduleScreen}
          options={{ tabBarLabel: 'Schedule', tabBarIcon: ({ color: c, size }) => <Feather name="calendar" size={size} color={c} /> }}
        />
      ) : null}
      {manager ? (
        <VTab.Screen
          name="Menu"
          component={MenuStackNav}
          options={{ tabBarLabel: cat.label, tabBarIcon: ({ color: c, size }) => <Feather name={cat.icon} size={size} color={c} /> }}
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
      <Stack.Screen name="VendorMyQr" component={VendorMyQrScreen} />
      <Stack.Screen name="VendorMySwiftNumber" component={VendorSwiftNumberScreen} />
    </Stack.Navigator>
  );
}
