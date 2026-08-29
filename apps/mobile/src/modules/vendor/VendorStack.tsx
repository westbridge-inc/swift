/** @jsxImportSource react */
import React, { useState, useEffect } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Pressable, RefreshControl, ScrollView, StatusBar, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import { Image } from 'expo-image';
import { color, elevation, radius, space } from '@swift/ui';
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
  Segmented,
  SettingsRow,
  T,
  TonePill,
} from '../../kit';
import { BrandSwitch } from '../../kit/controls';
import {
  BoardFirstRun,
  BoardFirstRunRow,
  DAY_LABELS,
  DeltaBadge,
  FulfillmentTag,
  GUTTER,
  InlineInput,
  KpiTile,
  OrderStatusPill,
  SubHeader,
  fmtDate,
  fmtClock as fmtLocalClock,
  fmtWhen,
  formatSlot,
  orderActions,
  prettyVendorType,
  type VendorOrderActionKind,
} from './shared';
import { VendorOrderDetailScreen } from './screens/VendorOrderDetailScreen';
import { VendorOrderHistoryScreen } from './screens/VendorOrderHistoryScreen';
import { VendorMyQrScreen } from './screens/VendorMyQrScreen';
import { VendorCategoryReviewScreen } from './screens/VendorCategoryReviewScreen';
import { GetHelpScreen } from '../profile/screens/GetHelpScreen';
import { DocumentChecklist } from '../../components/onboarding/DocumentChecklist';
import { PricingCard } from '../../components/onboarding/PricingCard';
import { MmgPayLinkCard } from '../../components/MmgPayLinkCard';
import { PublicCallNumberCard } from '../../components/PublicCallNumberCard';
import { CopyButton } from '../../components/billing/BillingSurfaces';
import { StandingCard } from '../../components/StandingCard';
import { API_URL, vendorApi } from '../../services/api';
import { disconnectSocket } from '../../services/socket';
import { openPayLink } from '../../lib/payLink';
import { toast } from '../../kit/toast';
import { useWentLive, WentLivePopup } from '../../components/onboarding/WentLive';
import { docLabel } from '../../components/onboarding/DocumentUploadCard';
import { useBecomePartner, useVerificationStatus } from '../../hooks/verification';
import {
  useVendorProfile,
  useVendorOrderHistory,
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
import { grantedLocationFix } from '../../lib/deviceLocation';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { useVendorPreview } from '../../stores/vendorPreview';
import { RoleSwitcherSheet } from '../../components/RoleSwitcherSheet';
import { money } from '../../lib/money';
import { payScreenState, type PayBandTone } from '../../lib/billing';
import { vendorSurfaceForRole } from '../../lib/vendorRbac';
import { inventorySummary } from '../../lib/vendorInventory';
import { mediaUrl } from '../../lib/images';
import { VendorBulkImportScreen } from '../../screens/vendor/VendorBulkImportScreen';
import { NewOrderTakeover } from './NewOrderTakeover';
import { Switch as AvailabilitySwitch } from '../../kit/switch';

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

type VendorMemberRole = 'OWNER' | 'MANAGER' | 'STAFF';

function safeVendorRole(value: unknown): VendorMemberRole | undefined {
  return value === 'OWNER' || value === 'MANAGER' || value === 'STAFF' ? value : undefined;
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

function HeaderAction({ label, tone = 'brand', onPress }: { label: string; tone?: 'brand' | 'muted'; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ minWidth: space['5xl'], minHeight: space['5xl'], alignItems: 'center', justifyContent: 'center' }}
    >
      {({ pressed }) => (
        <T variant="label" tone={tone} weight="medium" style={{ opacity: pressed ? 0.6 : 1 }}>
          {label}
        </T>
      )}
    </Pressable>
  );
}

/** Tab-root header: the board may replace the product eyebrow with a live store
 *  state; the other tabs retain the quiet Swift Business identity. */
function TabHeader({
  title,
  onSwitch,
  eyebrow = 'SWIFT BUSINESS',
  avatar,
  statusTone = 'brand',
}: {
  title: string;
  onSwitch?: () => void;
  eyebrow?: string;
  avatar?: string;
  statusTone?: 'brand' | 'success' | 'warning' | 'muted';
}) {
  const { logout } = useAuthStore();
  const statusColor =
    statusTone === 'success'
      ? color.success
      : statusTone === 'warning'
        ? color.warning
        : statusTone === 'muted'
          ? color.text.secondary
          : color.brand[500];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: GUTTER,
        paddingVertical: space.sm,
      }}
    >
      <View style={{ flex: 1, paddingRight: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <View style={{ width: space.sm, height: space.sm, borderRadius: radius.full, backgroundColor: statusColor }} />
          <T variant="micro" weight="bold" tone={statusTone === 'brand' ? 'brand' : 'muted'} numberOfLines={1}>
            {eyebrow}
          </T>
        </View>
        <T variant="title" numberOfLines={1}>
          {title}
        </T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
        {avatar ? (
          <View
            style={{
              width: space['4xl'],
              height: space['4xl'],
              borderRadius: radius.full,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: color.brand[500],
            }}
            accessibilityLabel={`${title} initial ${avatar}`}
          >
            <T variant="heading" weight="bold" tone="onBrand">
              {avatar}
            </T>
          </View>
        ) : null}
        {onSwitch ? <HeaderAction label="Switch app" onPress={onSwitch} /> : null}
        <HeaderAction label="Log out" tone="muted" onPress={logout} />
      </View>
    </View>
  );
}

function BusinessSetup() {
  const become = useBecomePartner();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { latitude, longitude, status: locationStatus } = useLocationStore();
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
  // [F-028-08] Persisted numbers are only a last-known map centre; they are a
  // STORE PIN — where customers are sent, where dispatch measures from — only
  // when the grant is live. The old existence check submitted a pin while
  // status was resolving/denied/unavailable, so a revoked permission could
  // register a business at wherever the phone last was.
  const pinFix = grantedLocationFix(latitude, longitude, locationStatus);
  const hasPin = pinFix !== null;
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
        latitude: pinFix!.latitude,
        longitude: pinFix!.longitude,
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
}: {
  order: any;
  onAction: (action: VendorOrderActionKind) => void;
  onOpen?: () => void;
  busy: boolean;
  showStore?: boolean;
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
    <Card>
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
    </View>
      )}
    </Pressable>
  );
}, (prev, next) => prev.order === next.order && prev.busy === next.busy && prev.showStore === next.showStore);

/**
 * THE EMPTY BOARD [UXR-W-003 · audit item 01].
 *
 * Owns the decision between "you are new" and "you are quiet", and owns its own
 * reads so they only ever fire when the board is actually empty — which is the
 * only moment any of it matters.
 *
 * The split is lifetime orders, a real server number from the profile store's
 * `_count.orders`, never a guess. While that number is unknown — loading, or
 * the read failed — we show the QUIET tile, because claiming someone is brand
 * new is the more damaging of the two mistakes and an outage already has its
 * own card upstream.
 */
/** The EXPERIENCED quiet board — unchanged, plus the one line that keeps quiet
 *  from reading as broken. */
function VendorBoardQuiet() {
  // One page, for one field: the newest order's timestamp.
  const historyQ = useVendorOrderHistory({ page: 1 });
  const lastOrderAt = (historyQ.data as any)?.data?.[0]?.createdAt;
  return (
    <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: color.brand[50], paddingVertical: space.xl, marginBottom: space.xl }}>
      <MaterialCommunityIcons name="check-circle-outline" size={28} color={color.text.muted} />
      <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
        You are all caught up
      </T>
      {lastOrderAt ? (
        <T variant="caption" tone="faint" style={{ marginTop: 2 }}>
          Last order {fmtLocalClock(lastOrderAt)}
        </T>
      ) : null}
    </View>
  );
}

function VendorBoardEmpty({ store, navigation, reachable, canManage }: any) {
  // The profile endpoint already carries `_count.orders` — the store's true
  // lifetime order count, loaded with the store itself. No extra request, and
  // no inference: if the count is absent we do NOT guess that someone is new.
  const lifetimeOrders: number | undefined = store?._count?.orders;
  const firstMorning = lifetimeOrders === 0;

  // Only the first-morning branch needs these, and it is the branch that runs
  // once in a store's life.
  const menuQ = useVendorMenu(firstMorning && canManage);
  const qrQ = useVendorQr(firstMorning && canManage);

  if (!firstMorning) return <VendorBoardQuiet />;

  const menuKnown = menuQ.isSuccess;
  const categories: any[] = menuKnown ? ((menuQ.data as any) ?? []) : [];
  const items: any[] = categories.flatMap((c: any) => c.items ?? []);
  const missingPhotos = items.filter((i: any) => !i.imageUrl).length;
  const shortUrl = (qrQ.data as any)?.shortUrl;
  const open = !!store.isCurrentlyOpen;

  return (
    <BoardFirstRun listening={reachable}>
      {canManage && !menuKnown ? (
        <BoardFirstRunRow
          index={1}
          label={menuQ.isError ? 'Menu status unavailable' : 'Checking your menu'}
          detail={menuQ.isError ? 'Open the menu to check its live items' : 'Loading your live catalogue facts'}
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
      ) : canManage && items.length === 0 ? (
        <BoardFirstRunRow
          index={1}
          label="Add your first item"
          detail={`Your ${catalogueMeta(store.vendorType).label.toLowerCase()} is empty — nothing to order yet`}
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
      ) : canManage ? (
        <BoardFirstRunRow
          index={1}
          label={`Add photos to your ${catalogueMeta(store.vendorType).label.toLowerCase()}`}
          done={missingPhotos === 0}
          // Phrased so it stays grammatical at every count, including one.
          detail={
            missingPhotos === 0
              ? `All ${items.length} items have a photo`
              : `Photos missing on ${missingPhotos} of ${items.length} items`
          }
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
      ) : null}
      <BoardFirstRunRow
        index={canManage ? 2 : 1}
        label={open ? 'You are open' : 'Your store is closed'}
        done={open}
        detail={
          open
            ? 'Customers can order right now'
            : canManage
              ? 'Use the switch below to start taking orders'
              : 'Ask a manager or owner to open the store'
        }
      />
      {canManage ? (
        <BoardFirstRunRow
          index={3}
          label="Share your store link"
          detail={shortUrl ?? (qrQ.isError ? 'Link unavailable — open My QR to retry' : 'Loading your live store link')}
          onPress={() => navigation.navigate('VendorMyQr')}
        />
      ) : null}
    </BoardFirstRun>
  );
}

type RevenueDay = {
  date: string;
  revenue: number;
  orders?: number;
  isToday?: boolean;
};

type HoursRow = {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
};

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const GUYANA_OFFSET_MILLISECONDS = 4 * 60 * 60 * 1000;

function numericFact(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n : null;
}

/** Guyana has no daylight-saving transition; shift once and read the UTC face. */
function guyanaDate(offsetDays = 0) {
  return new Date(Date.now() - GUYANA_OFFSET_MILLISECONDS + offsetDays * DAY_MILLISECONDS);
}

function guyanaDayKey(offsetDays = 0) {
  const d = guyanaDate(offsetDays);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function hasTrailingGuyanaDays(daily: RevenueDay[], take: number) {
  if (take <= 0) return false;
  const keys = new Set(daily.map((day) => day.date));
  return Array.from({ length: take }, (_, index) => guyanaDayKey(index - take + 1)).every((key) => keys.has(key));
}

function formatBusinessTime(value?: string | null) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [rawHour, minute] = value.split(':').map(Number);
  const suffix = rawHour! >= 12 ? 'PM' : 'AM';
  const hour = rawHour! % 12 || 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function normalizeHours(rows: any): HoursRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: any) => {
      const namedDay = typeof row?.day === 'string' ? DAY_LABELS.findIndex((d) => d.toLowerCase() === row.day.toLowerCase().slice(0, 3)) : -1;
      const dayOfWeek = Number.isInteger(row?.dayOfWeek) ? row.dayOfWeek : namedDay;
      if (dayOfWeek < 0 || dayOfWeek > 6) return null;
      return {
        dayOfWeek,
        openTime: String(row.openTime ?? row.open ?? ''),
        closeTime: String(row.closeTime ?? row.close ?? ''),
        isClosed: Boolean(row.isClosed ?? row.closed),
      };
    })
    .filter((row): row is HoursRow => row !== null)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

function hoursSummary(rows: any): string | null {
  const hours = normalizeHours(rows);
  if (hours.length === 0) return null;
  const open = hours.filter((row) => !row.isClosed);
  if (open.length === 0) return 'Closed all week';
  const first = open[0]!;
  const sameWindow = open.every((row) => row.openTime === first.openTime && row.closeTime === first.closeTime);
  const from = formatBusinessTime(first.openTime);
  const to = formatBusinessTime(first.closeTime);
  const window = from && to ? `${from}–${to}` : null;
  if (open.length === 7 && sameWindow && window) return `Daily · ${window}`;
  if (open.length === 1 && window) return `${DAY_LABELS[first.dayOfWeek]} · ${window}`;
  if (sameWindow && window) return `${open.length} open days · ${window}`;
  return `${open.length} open days · hours vary`;
}

function storeStatusEyebrow(store: any, inPreview: boolean) {
  if (inPreview) return { label: 'PREVIEW · READ ONLY', tone: 'brand' as const };
  const open = !!store?.isCurrentlyOpen;
  const accepting = !!store?.acceptingOrders;
  const today = normalizeHours(store?.operatingHours).find((row) => row.dayOfWeek === guyanaDate().getUTCDay());
  const schedule = today && !today.isClosed
    ? [formatBusinessTime(today.openTime), formatBusinessTime(today.closeTime)].filter(Boolean).join('–')
    : null;
  const status = !open ? 'CLOSED' : accepting ? 'OPEN' : 'OPEN · ORDERS PAUSED';
  return {
    label: schedule ? `${status} · TODAY ${schedule}` : status,
    tone: !open ? ('muted' as const) : accepting ? ('success' as const) : ('warning' as const),
  };
}

function normalizeRevenueDays(payload: any): RevenueDay[] {
  const rows: any[] = Array.isArray(payload) ? payload : Array.isArray(payload?.daily) ? payload.daily : [];
  return rows
    .map((row) => {
      const revenue = numericFact(row?.revenue ?? row?.total);
      if (!row?.date || revenue == null) return null;
      const orders = numericFact(row?.orders);
      return {
        date: String(row.date),
        revenue,
        ...(orders == null ? {} : { orders }),
        ...(row.isToday === undefined ? {} : { isToday: !!row.isToday }),
      };
    })
    .filter((row): row is RevenueDay => row !== null);
}

/** The revenue endpoint currently ends its dense series yesterday. Overview owns
 *  today's completed sales, so combine the two server reads rather than drawing
 *  a false zero or silently dropping today. Preview rows already identify today. */
function reconciledRevenueDays(payload: any, overview: any, requestedDays: number): RevenueDay[] {
  const rows = normalizeRevenueDays(payload);
  if (rows.length === 0 || rows.some((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date))) return rows;
  const todayRevenue = numericFact(overview?.today?.revenue ?? overview?.today?.total);
  const key = guyanaDayKey();
  const existingToday = rows.find((row) => row.date === key);
  const endpointOrders = numericFact(payload?.totals?.orders);
  const allBucketsKnown = rows.every((row) => numericFact(row.orders) != null);
  const bucketedOrders = allBucketsKnown
    ? rows.reduce((sum, row) => sum + Number(row.orders), 0)
    : null;
  // Overview.today.orders is every still-live order placed today, while this
  // series is completed orders only. Recover the missing completed-today bucket
  // from the revenue endpoint's own total instead of corrupting AOV with the
  // broader overview count.
  const inferredTodayOrders = endpointOrders != null && bucketedOrders != null
    ? endpointOrders - bucketedOrders
    : null;
  const todayOrders = numericFact(existingToday?.orders) ?? (inferredTodayOrders != null && inferredTodayOrders >= 0 ? inferredTodayOrders : null);
  if (todayRevenue == null) return rows;
  return [
    ...rows.filter((row) => row.date !== key),
    { date: key, revenue: todayRevenue, ...(todayOrders == null ? {} : { orders: todayOrders }), isToday: true },
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-requestedDays);
}

function HubFact({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <View style={{ flex: 1, borderRadius: radius.md, backgroundColor: color.surface.sunken, padding: space.md }}>
      <T variant="micro" tone="muted">
        {label}
      </T>
      <T variant="numM" numberOfLines={1} style={{ marginTop: space.xs }}>
        {value}
      </T>
      <T variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: space.xs }}>
        {detail}
      </T>
    </View>
  );
}

function VendorRevenuePulse({
  analytics,
  newOrders,
  analyticsError,
  analyticsLoading,
  analyticsUpdatedAt,
}: {
  analytics: any;
  newOrders: any[];
  analyticsError: boolean;
  analyticsLoading: boolean;
  analyticsUpdatedAt: number;
}) {
  const revenueQ = useVendorRevenue(14);
  const opsQ = useVendorOps(7);
  const refetchRevenue = revenueQ.refetch;
  const revenueBehindAnalytics = analyticsUpdatedAt > 0 && analyticsUpdatedAt > revenueQ.dataUpdatedAt;
  useEffect(() => {
    if (analyticsUpdatedAt > 0) void refetchRevenue();
  }, [analyticsUpdatedAt, refetchRevenue]);
  const todayRevenue = numericFact(analytics?.today?.revenue ?? analytics?.today?.total);
  const todayOrders = numericFact(analytics?.today?.orders ?? analytics?.today?.count);
  const pendingOrders = numericFact(analytics?.pendingOrders);
  const pendingCatchingUp = pendingOrders != null && newOrders.length > pendingOrders;
  const pendingLoadedFallback = pendingOrders == null && newOrders.length > 0;
  const pendingDisplay = pendingCatchingUp || pendingLoadedFallback ? newOrders.length : pendingOrders;
  const daily = reconciledRevenueDays(revenueQ.data, analytics, 14);
  const previousSameDay = daily.find((row) => row.date === guyanaDayKey(-7));
  const previousLabel = DAY_LABELS[guyanaDate(-7).getUTCDay()];
  const avgAccept = numericFact(opsQ.data?.avgAcceptMinutes);
  const ordersDetail = opsQ.isLoading && !opsQ.data
    ? 'Average accept time loading…'
    : opsQ.isError && !opsQ.data
      ? 'Average accept time unavailable'
      : avgAccept == null
        ? 'No acceptance time reported · 7d'
        : `${avgAccept}m avg to accept · 7d${opsQ.isError ? ' · last loaded' : ''}`;
  const showingStale = (analyticsError && !!analytics) || (revenueQ.isError && !!revenueQ.data);
  const factsUnavailable = analyticsError && !analytics;
  const oldestKnown = pendingOrders != null && pendingOrders === newOrders.length;
  const oldestTimestamp = oldestKnown
    ? newOrders
        .map((order) => order.placedAt ?? order.createdAt)
        .filter(Boolean)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]
    : undefined;
  const waitingDetail = pendingCatchingUp
    ? 'updating live total'
    : pendingOrders === 0
      ? 'Nothing waiting'
    : oldestTimestamp
      ? `oldest ${fmtWhen(oldestTimestamp)}`
      : pendingOrders == null
        ? 'Total unavailable'
        : 'live queue total';

  return (
    <View style={[{ borderRadius: radius.lg, backgroundColor: color.surface.base, padding: space.xl, marginBottom: space.lg }, elevation.card]}>
      <T variant="micro" tone="muted">
        REVENUE TODAY
      </T>
      {showingStale || factsUnavailable || analyticsLoading ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          {showingStale
            ? 'Showing last loaded figures — refresh did not complete.'
            : factsUnavailable
              ? 'Live business facts are unavailable — pull to retry.'
              : 'Loading live business facts…'}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md }}>
        <T variant="displayXl" numberOfLines={1} style={{ flexShrink: 1, marginTop: space.xs }}>
          {todayRevenue == null ? '—' : money(todayRevenue)}
        </T>
        {todayRevenue != null && previousSameDay && !analyticsError && !revenueQ.isError && !revenueBehindAnalytics ? (
          <View style={{ alignItems: 'flex-end', paddingBottom: space.xs }}>
            <DeltaBadge cur={todayRevenue} prev={previousSameDay.revenue} />
            <T variant="caption" tone="muted">
              vs last {previousLabel}
            </T>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg }}>
        <HubFact
          label="ORDERS"
          value={todayOrders == null ? '—' : String(todayOrders)}
          detail={ordersDetail}
        />
        <HubFact
          label="WAITING"
          value={pendingDisplay == null ? '—' : `${pendingDisplay}${pendingCatchingUp || pendingLoadedFallback ? '+' : ''}`}
          detail={waitingDetail}
        />
      </View>
    </View>
  );
}

function ManageTile({
  icon,
  label,
  detail,
  badge,
  badgeLabel,
  onPress,
  wide,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  detail: string;
  badge?: React.ReactNode;
  badgeLabel?: string;
  onPress: () => void;
  wide?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[label, detail, badgeLabel].filter(Boolean).join('. ')}
      accessibilityHint={`Open ${label}`}
      style={{ flexGrow: 1, flexBasis: wide ? '100%' : '46%' }}
    >
      {({ pressed }) => (
        <View
          style={[
            {
              flex: 1,
              borderRadius: radius.lg,
              backgroundColor: color.surface.base,
              padding: space.lg,
              opacity: pressed ? 0.82 : 1,
            },
            elevation.card,
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm }}>
            <View
              style={{
                width: space['4xl'],
                height: space['4xl'],
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: color.brand[50],
              }}
            >
              <MaterialCommunityIcons name={icon} size={20} color={color.brand[600]} />
            </View>
            {badge ?? null}
          </View>
          <T variant="heading" numberOfLines={2} style={{ marginTop: space.md }}>
            {label}
          </T>
          <T variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: space.xs }}>
            {detail}
          </T>
          <Feather name="arrow-up-right" size={16} color={color.brand[500]} style={{ marginTop: space.md }} />
        </View>
      )}
    </Pressable>
  );
}

function financialDeltaLabel(cur: number, prev: number | null) {
  if (prev == null) return undefined;
  if (prev <= 0) return cur > 0 ? 'New revenue in this period' : undefined;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (Math.abs(pct) < 1) return 'Revenue level with previous period';
  return `Revenue ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)} percent`;
}

function subscriptionTone(sub: any): 'brand' | 'success' | 'neutral' | 'error' | 'warning' {
  if (sub?.status === 'ACTIVE') return 'success';
  if (sub?.status === 'PAST_DUE') return 'warning';
  if (sub?.status === 'SUSPENDED' || sub?.status === 'CHURNED') return 'error';
  if (sub?.isTrialActive || sub?.status === 'TRIAL') return 'brand';
  return 'neutral';
}

function billingSummary(sub: any) {
  if (!sub) return 'Subscription not active';
  if (sub.isInGracePeriod && sub.gracePeriodEnd) return `Pay by ${fmtDate(sub.gracePeriodEnd)}`;
  const next = sub.nextBillingDate ? `Next bill ${fmtDate(sub.nextBillingDate)}` : null;
  const rail = sub.billingMethod === 'MOBILE_MONEY' ? 'MMG' : sub.billingMethod === 'CASH' ? 'cash' : null;
  return [next, rail].filter(Boolean).join(' · ') || String(sub.status ?? 'Subscription').toLowerCase();
}

function VendorBillingNotice({ sub, onPay }: { sub: any; onPay: () => void }) {
  if (!sub) return null;
  const status = String(sub.status ?? '').toUpperCase();
  const blocked = status === 'SUSPENDED' || status === 'CHURNED';
  const behind = !blocked && (sub.isInGracePeriod || status === 'PAST_DUE');
  if (!blocked && !behind) return null;
  const due = numericFact(sub.amountDueGyd);
  const deadline = sub.gracePeriodEnd ? fmtDate(sub.gracePeriodEnd) : null;

  return (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: blocked ? color.soft.danger : color.soft.warning,
        padding: space.lg,
        marginBottom: space.lg,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Feather name={blocked ? 'alert-circle' : 'alert-triangle'} size={18} color={blocked ? color.error : color.warning} />
        <T variant="body" weight="semibold" tone={blocked ? 'error' : 'warning'} style={{ flex: 1 }}>
          {blocked ? 'Billing hold needs attention' : `Weekly fee due${deadline ? ` by ${deadline}` : ''}`}
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        {blocked
          ? 'Pay using your Swift Number. Confirmation clears the billing hold; any separate verification hold remains.'
          : 'Pay using your Swift Number to keep the weekly fee current.'}
      </T>
      {due != null && due > 0 ? (
        <T variant="label" weight="semibold" style={{ marginTop: space.sm }}>
          Due now: {money(due)}
        </T>
      ) : null}
      <PillButton label="How to pay" icon="hash" size="md" style={{ marginTop: space.md }} onPress={onPay} />
    </View>
  );
}

/** The tone of the state band — one 8px dot and one coloured word, never a
 *  filled tint card [Swift Pay §1a, "Colour budget"]. Viridian for covered,
 *  burnt amber for owed, ink for paused. Nothing on this screen turns red:
 *  being behind on a bill is not an error state, it is a Tuesday. */
const PAY_BAND_INK: Record<PayBandTone, string> = {
  covered: color.success,
  owed: color.warning,
  paused: color.text.primary,
};

function VendorSwiftNumberScreen({ navigation }: any) {
  const q = useVendorSubscription();
  const insets = useSafeAreaInsets();
  const [aboutOpen, setAboutOpen] = useState(false);
  const sub: any = q.data;
  const swiftNumber = String(sub?.sanFormatted ?? sub?.san ?? '');
  const steps: string[] = Array.isArray(sub?.payCashSteps) ? sub.payCashSteps : [];
  const state = payScreenState(sub);
  const bandInk = PAY_BAND_INK[state.tone];
  const activationCopy = typeof sub?.activationCopy === 'string' ? sub.activationCopy : '';

  // The two standing facts about the fee. Declared once and rendered in two
  // places (the header's (i) sheet and the page footer) so the sheet can never
  // drift from the fine print it explains.
  const FEE_ONLY_CHARGE = 'The weekly fee is Swift’s only charge — you keep everything you earn.';
  const HOLD_NOTE = 'Confirmation clears a billing hold. Any separate verification hold remains until its own issue is fixed.';

  return (
    // `bleed` so the maroon runs under the status bar. A paper strip above a
    // maroon bar reads as a broken banner, not as chrome.
    <Screen bleed>
      {/* THE ONE MAROON HEADER. Every other customer/vendor surface is paper —
          this screen is the deliberate exception: the fee is Swift's own
          business with the vendor, so Swift's colour signs it. Built inline
          rather than via SubHeader, which paints ink-on-paper only and has no
          tone/right-glyph props; it is shared by four other screens, so
          widening it is not this file's change to make. */}
      <StatusBar barStyle="light-content" />
      <View style={{ backgroundColor: color.brand[500], paddingTop: insets.top }}>
        <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: GUTTER }}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
            {({ pressed }) => (
              <View style={{ width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
                <Feather name="chevron-left" size={24} color={color.text.onBrand} />
              </View>
            )}
          </Pressable>
          <T
            variant="heading"
            tone="onBrand"
            numberOfLines={1}
            accessibilityRole="header"
            style={{ flex: 1, textAlign: 'center', paddingHorizontal: space.md }}
          >
            Weekly fee
          </T>
          <Pressable
            onPress={() => setAboutOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="About the weekly fee"
          >
            {({ pressed }) => (
              <View style={{ width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
                <Feather name="info" size={20} color={color.text.onBrand} />
              </View>
            )}
          </Pressable>
        </View>
      </View>
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.isError && !sub ? (
        <ErrorState message="We couldn't load your Swift Number. Check your connection and try again." onRetry={() => q.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={color.brand[500]} />}
        >
          {q.isError ? (
            <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
              Showing the last loaded billing details — refresh did not complete.
            </T>
          ) : null}
          {/* THE AMOUNT, AS HERO. The most readable thing we can put on a cheap
              screen in sunlight — near-black ink on paper, not brand, not a
              tint card. A vendor checking whether they owe anything should need
              one glance, so nothing else on this screen competes with it. */}
          <View style={{ paddingTop: space['2xl'], paddingBottom: space.lg }}>
            <T variant="micro" tone="muted">
              {state.eyebrow}
            </T>
            <T variant="displayXl" style={{ marginTop: space.sm }}>
              {money(state.amountGyd)}
            </T>
            {state.covers ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                {state.covers}
              </T>
            ) : null}
          </View>

          {/* THE BAND, in a soft neutral box — surface.sunken, NOT a brand tint:
              the box is a shelf for the state, and colour on this screen is
              spent only on the dot and the one word beside it. The four states
              differ only here; the rest of the screen never moves. */}
          <View
            style={{
              backgroundColor: color.surface.sunken,
              borderRadius: radius.lg,
              padding: space.lg,
              marginBottom: space.lg,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: bandInk }} />
              <T variant="body" weight="semibold" style={{ flex: 1, color: bandInk }}>
                {state.title}
              </T>
            </View>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              {state.body}
            </T>
            {state.extra ? (
              // PINV-8, in the vendor's own words. Proven server-side by
              // api/src/__tests__/billing-suspension-retention.test.ts.
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                {state.extra}
              </T>
            ) : null}
          </View>

          {/* DOOR 2 — the account number, and the steps that use it, in ONE
              card: they are a single act.

              Door 1 (card) is deliberately absent. It needs WiPay, and whether
              WiPay settles GYD at all is still an open question (PAY-1
              BLOCKER-1). The design slide shows a "Pay by card" button; adding
              it before that answer arrives would be the screen lying about a
              door that does not open, so there is exactly one door here.

              Copy-number IS here, and it should have been from the start — I
              told the builder it needed a native module the app doesn't ship,
              and that was wrong. `lib/clipboard.ts` already wraps the copy in a
              guarded require and REPORTS whether it happened, and the same
              button has been live on the rider's Swift Number screen for a
              while. Same number, same rail, so the vendor had strictly less. It
              is the shared component, not a second copy of it.

              The QR is still absent, for a narrower reason than I first gave:
              react-native-svg is a dependency and GET /vendor/qr does return an
              SVG — but that is the STOREFRONT code customers scan to order, not
              a payment code. Rendering it here would put the wrong QR on a money
              screen. It needs a SAN payload endpoint, and MMG-Q1 (can an agent
              terminal even scan one?) is still unanswered. */}
          <Card style={{ marginBottom: space.lg, borderWidth: 1, borderColor: color.border.subtle }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <IconChip icon="hash" size={44} />
              <View style={{ flex: 1 }}>
                <T variant="heading">Pay with account number</T>
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  MMG app, or cash at any agent
                </T>
              </View>
            </View>

            <T variant="displayXl" selectable style={{ marginTop: space.lg }}>
              {swiftNumber || '—'}
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              Give this to the agent. It never changes.
            </T>

            {/* Copies the RAW digits — an agent keys digits into a terminal. */}
            {sub?.san ? (
              <View style={{ marginTop: space.lg, alignSelf: 'flex-start' }}>
                <CopyButton san={String(sub.san)} />
              </View>
            ) : null}

            <View style={{ marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: color.border.subtle }}>
              <T variant="heading">How to pay</T>
              {steps.length > 0 ? (
                <View style={{ marginTop: space.sm }}>
                  {steps.map((step, index) => (
                    <View key={step} style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                      <View
                        style={{
                          width: space['3xl'],
                          height: space['3xl'],
                          borderRadius: radius.full,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: color.brand[50],
                        }}
                      >
                        <T variant="label" weight="bold" tone="brand">
                          {index + 1}
                        </T>
                      </View>
                      <T variant="label" style={{ flex: 1 }}>
                        {step}
                      </T>
                    </View>
                  ))}
                </View>
              ) : (
                <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
                  Payment steps were not returned. Show your Swift Number to an MMG agent and confirm the amount before paying.
                </T>
              )}
            </View>
          </Card>

          {/* The design also shows a quiet "Receipts" link under this card. The
              vendor stack registers no receipts/billing-history route and the
              subscription payload carries no payment history, so the link is
              omitted rather than pointed at nothing. */}

          {/* The waiting state, said plainly. A vendor who has just handed cash
              to an agent is standing there wondering what to do next, and the
              honest answer is "nothing" — the rail is a push, we watch for it. */}
          <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
            {activationCopy ? `${activationCopy} ` : ''}There is nothing to type here — we watch for the payment and update this screen ourselves.
          </T>

          <T variant="caption" tone="muted" center>
            {FEE_ONLY_CHARGE}
          </T>

          <T variant="caption" tone="faint" center style={{ marginTop: space.sm }}>
            {HOLD_NOTE}
          </T>
        </ScrollView>
      )}

      {/* What the (i) in the header opens. Same two facts as the footer, said
          once in the place a vendor taps when they are asking "what IS this?". */}
      <PopupCard visible={aboutOpen} onClose={() => setAboutOpen(false)}>
        <IconChip icon="info" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          About the weekly fee
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {FEE_ONLY_CHARGE}
        </T>
        <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
          {HOLD_NOTE}
        </T>
        <PillButton
          label="Got it"
          variant="soft"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => setAboutOpen(false)}
        />
      </PopupCard>
    </Screen>
  );
}

function VendorManagerManageGrid({ navigation, store, myRole, analytics, analyticsStale, analyticsUpdatedAt }: any) {
  const [shareOpen, setShareOpen] = useState(false);
  const menuQ = useVendorMenu();
  const revenueQ = useVendorRevenue(14);
  const hoursQ = useVendorHours();
  const qrQ = useVendorQr();
  const isOwner = myRole === 'OWNER';
  const subQ = useVendorSubscription(isOwner);
  const categories: any[] = menuQ.data ?? [];
  const items = categories.flatMap((category: any) => category.items ?? []);
  const soldOut = items.filter((item: any) => item.isAvailable === false).length;
  const active = Math.max(0, items.length - soldOut);
  const daily = reconciledRevenueDays(revenueQ.data, analytics, 14);
  const revenueWindow = windowTotals(daily, 7);
  const revenueBehindAnalytics = analyticsUpdatedAt > 0 && analyticsUpdatedAt > revenueQ.dataUpdatedAt;
  const revenueKnown = revenueQ.isSuccess && !analyticsStale && !revenueBehindAnalytics && !!analytics && hasTrailingGuyanaDays(daily, 7);
  const schedule = hoursSummary(hoursQ.data ?? store?.operatingHours);
  const sub = subQ.data ?? store?.subscription;
  const rollingOrders = analyticsStale ? null : numericFact(analytics?.week?.orders);
  const menuStale = menuQ.isError && !!menuQ.data;
  const hoursStale = hoursQ.isError && !!hoursQ.data;
  const qrStale = qrQ.isError && !!qrQ.data;
  const subStale = subQ.isError && !!sub;
  const menuDetail = menuQ.isError && !menuQ.data
    ? 'Catalogue unavailable'
    : menuQ.isLoading && !menuQ.data
      ? 'Checking live catalogue…'
      : `${active} active · ${soldOut} sold out${menuStale ? ' · last loaded' : ''}`;
  const revenueDetail = revenueKnown
    ? `7d ${money(revenueWindow.cur.revenue)}`
    : revenueBehindAnalytics && revenueQ.isError
      ? 'Revenue refresh failed'
      : revenueQ.isLoading || revenueBehindAnalytics || (!analytics && !analyticsStale)
      ? 'Checking 7-day revenue…'
      : analyticsStale && analytics
        ? 'Revenue · last loaded'
        : 'Revenue unavailable';
  const revenueDelta = revenueKnown ? financialDeltaLabel(revenueWindow.cur.revenue, revenueWindow.prev?.revenue ?? null) : undefined;
  const qrDetail = qrQ.isError && !qrQ.data
    ? 'Store link unavailable'
    : qrQ.data?.shortUrl
      ? `${qrQ.data.shortUrl}${qrStale ? ' · last loaded' : ''}`
      : qrQ.isLoading
        ? 'Checking store link…'
        : 'Customers scan to order';
  const scheduleDetail = hoursQ.isError && !store?.operatingHours
    ? 'Hours unavailable'
    : `${schedule ?? 'Schedule not set'}${hoursStale ? ' · last loaded' : ''}`;

  return (
    <View style={{ marginTop: space.lg, marginBottom: space.xl }}>
      <T variant="micro" tone="muted">
        MANAGE
      </T>
      <T variant="heading" style={{ marginTop: space.xs, marginBottom: space.md }}>
        The whole business
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        <ManageTile
          icon="book-open-outline"
          label="Menu & inventory"
          detail={menuDetail}
          badge={soldOut > 0 ? <TonePill label={`${soldOut} SOLD OUT`} tone="warning" /> : undefined}
          badgeLabel={soldOut > 0 ? `${soldOut} sold out` : undefined}
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
        <ManageTile
          icon="chart-bar"
          label="Insights"
          detail={revenueDetail}
          badge={revenueKnown ? <DeltaBadge cur={revenueWindow.cur.revenue} prev={revenueWindow.prev?.revenue ?? null} /> : undefined}
          badgeLabel={revenueDelta}
          onPress={() => navigation.navigate('Insights')}
        />
        <ManageTile
          icon="calendar-clock-outline"
          label="Hours & schedule"
          detail={scheduleDetail}
          onPress={() => navigation.navigate(store?.vendorType === 'SERVICE' ? 'Schedule' : 'Account')}
        />
        <ManageTile
          icon="qrcode-scan"
          label={isOwner ? 'My QR & number' : 'My QR'}
          detail={qrDetail}
          badge={qrQ.data?.status ? <TonePill label={String(qrQ.data.status).replace(/_/g, ' ')} tone={qrQ.data.status === 'ACTIVE' ? 'success' : 'neutral'} /> : undefined}
          badgeLabel={qrQ.data?.status ? `QR ${String(qrQ.data.status).replace(/_/g, ' ').toLowerCase()}` : undefined}
          onPress={() => (isOwner ? setShareOpen(true) : navigation.navigate('VendorMyQr'))}
        />
        <ManageTile
          icon="history"
          label="Order history"
          detail={rollingOrders == null ? 'Past orders' : `${rollingOrders} recent orders`}
          onPress={() => navigation.navigate('VendorOrderHistory')}
        />
        <ManageTile
          icon={isOwner ? 'cash-check' : 'account-cog-outline'}
          label={isOwner ? 'Billing' : 'Account'}
          detail={isOwner ? (subQ.isError && !sub ? 'Billing unavailable' : `${billingSummary(sub)}${subStale ? ' · last loaded' : ''}`) : 'Store settings & promos'}
          badge={isOwner && sub ? <TonePill label={String(sub.status ?? 'Subscription').replace(/_/g, ' ')} tone={subscriptionTone(sub)} /> : undefined}
          badgeLabel={isOwner && sub ? `Subscription ${String(sub.status ?? '').replace(/_/g, ' ').toLowerCase()}` : undefined}
          onPress={() => navigation.navigate('Account')}
        />
      </View>
      <PopupCard visible={shareOpen} onClose={() => setShareOpen(false)}>
        <IconChip icon="share-2" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Share or pay
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Your store QR is for customers. Your Swift Number is for the weekly fee.
        </T>
        <PillButton
          label="Open store QR"
          icon="grid"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            setShareOpen(false);
            navigation.navigate('VendorMyQr');
          }}
        />
        <PillButton
          label="Open Swift Number"
          icon="hash"
          variant="soft"
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          onPress={() => {
            setShareOpen(false);
            navigation.navigate('VendorMySwiftNumber');
          }}
        />
      </PopupCard>
    </View>
  );
}

function VendorStaffAvailability({ navigation }: any) {
  const menuQ = useVendorMenu();
  const items = ((menuQ.data ?? []) as any[]).flatMap((category: any) => category.items ?? []);
  const soldOut = items.filter((item: any) => item.isAvailable === false).length;
  const detail = menuQ.isError && !menuQ.data
    ? 'Availability unavailable'
    : menuQ.isLoading && !menuQ.data
      ? 'Checking live catalogue…'
      : `${soldOut} sold out · one-tap updates${menuQ.isError && menuQ.data ? ' · last loaded' : ''}`;
  return (
    <View style={{ marginTop: space.lg, marginBottom: space.xl }}>
      <T variant="micro" tone="muted" style={{ marginBottom: space.md }}>
        FLOOR TOOLS
      </T>
      <View style={{ flexDirection: 'row' }}>
        <ManageTile
          wide
          icon="toggle-switch-outline"
          label="Item availability"
          detail={detail}
          badge={soldOut > 0 ? <TonePill label={`${soldOut} SOLD OUT`} tone="warning" /> : undefined}
          badgeLabel={soldOut > 0 ? `${soldOut} sold out` : undefined}
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
      </View>
    </View>
  );
}

function VendorOps({ store, navigation }: any) {
  const [queueOpen, setQueueOpen] = useState(false);
  const [switchingStore, setSwitchingStore] = useState(false);
  const toggleOpen = useToggleOpen();
  const toggleOrders = useToggleOrders();
  const setSelfDelivery = useSetSelfDelivery();
  const orderAction = useOrderAction();
  const ordersQ = useVendorOrders(true);
  const { stores, owner } = useVendorProfile();
  const myRole = safeVendorRole(owner?.myRole);
  const canManage = myRole === 'OWNER' || myRole === 'MANAGER';
  // Client mirror of the lane's least-privilege surface: STAFF gets the queue
  // plus availability, while money, authoring and settings stay with managers.
  // In sample/pending preview myRole is OWNER, so the full owner view still shows.
  const surface = vendorSurfaceForRole(myRole);
  const analyticsQ = useVendorAnalytics(surface.canSeeMoney);
  // §B preview: the board renders for a not-yet-ACTIVE store (pending vendor) OR
  // for a prospective vendor walking a read-only SAMPLE dashboard (previewType).
  const previewType = useVendorPreview((s) => s.previewType);
  const inPreview = store.status !== 'ACTIVE' || !!previewType;
  const exitPreview = useVendorPreview((s) => s.exitPreview);
  const setPreviewType = useVendorPreview((s) => s.setPreviewType);
  const setPreviewIntent = useAuthStore((s) => s.setIntent);
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
  const switchStore = async (id: string) => {
    if (id === store.id || switchingStore) return;
    setSwitchingStore(true);
    disconnectSocket();
    setSelectedStore(id);
    try {
      // Store-aware query keys live outside this lane. Reset the shared cache
      // so the next store never inherits the previous store's role or facts.
      await Promise.all([
        qc.resetQueries({ queryKey: ['vendor'] }),
        qc.resetQueries({ queryKey: ['verification'] }),
      ]);
    } finally {
      setSwitchingStore(false);
    }
  };
  const fetched: any[] = ordersQ.data ?? [];
  const boardLoading = ordersQ.isLoading && !ordersQ.data;
  const boardUnavailable = ordersQ.isError && !ordersQ.data;
  const open = !!store.isCurrentlyOpen;
  const accepting = !!store.acceptingOrders;
  const selfDelivery = !!store.selfDeliveryEnabled;
  const busy = orderAction.isPending;

  // The live board works the open queue; finished orders live in History.
  const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
  const orders = fetched.filter((o) => !TERMINAL.includes((o.status || '').toUpperCase()));
  const isNew = (s: string) => ['PENDING', 'PLACED'].includes((s || '').toUpperCase());
  // Express bought its place at the FRONT of the kitchen queue — the customer
  // paid for it and the rider cascade runs on a shorter clock.
  const expressFirst = (a: any, b: any) => {
    const priority = Number(!!b.isExpress) - Number(!!a.isExpress);
    if (priority !== 0) return priority;
    const time = (order: any) => {
      const value = new Date(order.placedAt ?? order.createdAt ?? '').getTime();
      return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    };
    return time(a) - time(b);
  };
  const newOrders = orders.filter((o) => isNew(o.status)).sort(expressFirst);
  const inProgress = orders.filter((o) => !isNew(o.status)).sort(expressFirst);
  const status = storeStatusEyebrow(store, inPreview);
  const storeStatusText = (
    <View style={{ flex: 1, paddingRight: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <View style={{ width: space.md, height: space.md, borderRadius: radius.full, backgroundColor: !inPreview && open && accepting ? color.success : color.text.muted }} />
        <T variant="body" weight="bold">
          {inPreview ? 'Not open yet' : !open ? 'Store closed' : accepting ? 'Open for orders' : 'Orders paused'}
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        {inPreview
          ? 'Your store opens for orders once verification is approved.'
          : !open ? 'Not currently open to customers' : accepting ? 'Accepting new orders' : 'You’re open but not taking new orders'}
      </T>
    </View>
  );

  if (switchingStore) {
    return (
      <Screen>
        <TabHeader title="Switching store…" eyebrow="LOADING BUSINESS" statusTone="muted" />
        <LoadingBlock />
      </Screen>
    );
  }

  return (
    <Screen>
      <TabHeader
        title={store.name}
        eyebrow={status.label}
        statusTone={status.tone}
        avatar={String(store.name ?? 'S').trim().charAt(0).toUpperCase() || 'S'}
      />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={ordersQ.isRefetching || analyticsQ.isRefetching}
            onRefresh={() => void qc.invalidateQueries({ queryKey: ['vendor'] })}
            tintColor={color.brand[500]}
          />
        }
      >
        {/* Multi-store switcher — only when the owner has more than one store. */}
        {stores.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.lg }} contentContainerStyle={{ gap: space.md }}>
            {stores.map((s: any) => (
              <Chip key={s.id} label={s.name} selected={s.id === store.id} onPress={() => void switchStore(s.id)} />
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
                style={{ minWidth: space['5xl'], minHeight: space['5xl'], alignItems: 'center', justifyContent: 'center' }}
              >
                <T variant="label" tone="brand" weight="bold">Exit</T>
              </Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }}>
              {TYPES.map((t) => (
                <Chip key={t.key} label={t.label} selected={previewType === t.key} onPress={() => setPreviewType(t.key)} />
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

        {surface.canSeeMoney ? (
          <VendorRevenuePulse
            analytics={analyticsQ.data}
            newOrders={newOrders}
            analyticsError={analyticsQ.isError}
            analyticsLoading={analyticsQ.isLoading}
            analyticsUpdatedAt={analyticsQ.dataUpdatedAt}
          />
        ) : (
          <View style={{ borderRadius: radius.lg, backgroundColor: color.surface.sunken, padding: space.lg, marginBottom: space.lg }}>
            <T variant="micro" tone="muted">
              LOADED BOARD
            </T>
            <T variant="numL" style={{ marginTop: space.xs }}>
              {boardLoading || boardUnavailable ? '—' : String(orders.length)}
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              {boardLoading
                ? 'Loading the latest queue…'
                : boardUnavailable
                ? 'Board unreachable — orders may be waiting'
                : `${newOrders.length} new · ${inProgress.length} in progress in the latest page`}
            </T>
          </View>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.md }}>
          <View>
            <T variant="micro" tone="muted">
              LATEST QUEUE VIEW
            </T>
            <T variant="heading" style={{ marginTop: space.xs }}>
              {boardLoading
                ? 'Loading active orders…'
                : boardUnavailable
                  ? 'Queue status unavailable'
                : orders.length === 0
                  ? 'No active orders shown'
                  : `${orders.length} shown · ${newOrders.length} waiting here`}
            </T>
          </View>
          {newOrders.length > 0 ? <TonePill label={`${newOrders.length} NEW`} tone="warning" /> : null}
        </View>
        {ordersQ.isError && ordersQ.data ? (
          <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
            Showing the last loaded queue — refresh did not complete.
          </T>
        ) : null}
        {!ordersQ.isLoading && !(ordersQ.isError && !ordersQ.data) && newOrders.length === 0 && orders.length > 0 ? (
          <VendorBoardEmpty
            store={store}
            navigation={navigation}
            reachable={!ordersQ.isError}
            canManage={canManage}
          />
        ) : null}
        {ordersQ.isLoading ? (
          <LoadingBlock />
        ) : ordersQ.isError && !ordersQ.data ? (
          // [WR-016] An outage must never wear the "caught up" costume: with no
          // data at all, say so and offer retry — orders may be waiting.
          <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: color.brand[50], paddingVertical: space.xl, marginBottom: space.xl }}>
            <MaterialCommunityIcons name="wifi-off" size={28} color={color.text.muted} />
            <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
              Can&apos;t reach the order board — orders may be waiting.
            </T>
            <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.md }} onPress={() => ordersQ.refetch()} />
          </View>
        ) : orders.length === 0 ? (
          <VendorBoardEmpty
            store={store}
            navigation={navigation}
            reachable={!ordersQ.isError}
            canManage={canManage}
          />
        ) : queueOpen ? (
          <>
            <T variant="micro" tone="muted" style={{ marginBottom: space.sm }}>
              NEW ORDERS
            </T>
            {newOrders.length === 0 ? (
              <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
                Nothing is waiting for an answer.
              </T>
            ) : null}
            {newOrders.map((o) => (
              <VendorOrderCard
                key={o.id}
                order={o}
                busy={busy}
                onAction={(action) => orderAction.mutate({ id: o.id, action })}
                onOpen={() => navigation.navigate('VendorOrderDetail', { orderId: o.id, orderNumber: o.orderNumber })}
              />
            ))}
            {inProgress.length > 0 ? (
              <>
                <T variant="micro" tone="muted" style={{ marginTop: space.md, marginBottom: space.sm }}>
                  IN PROGRESS · {inProgress.length}
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
          </>
        ) : (
          <>
            <T variant="micro" tone="muted" style={{ marginBottom: space.sm }}>
              {newOrders.length > 0 ? 'WAITING FOR ANSWER' : 'IN PROGRESS'}
            </T>
            <VendorOrderCard
              order={newOrders[0] ?? inProgress[0]}
              busy={busy}
              onAction={(action) => orderAction.mutate({ id: (newOrders[0] ?? inProgress[0]).id, action })}
              onOpen={() => {
                const order = newOrders[0] ?? inProgress[0];
                navigation.navigate('VendorOrderDetail', { orderId: order.id, orderNumber: order.orderNumber });
              }}
            />
          </>
        )}
        {orders.length > 0 && !(ordersQ.isError && !ordersQ.data) ? (
          <PillButton
            label={queueOpen ? 'Collapse loaded queue' : `Open loaded queue · ${orders.length}`}
            variant="soft"
            size="md"
            icon={queueOpen ? 'chevron-up' : 'list'}
            style={{ marginBottom: space.lg }}
            onPress={() => setQueueOpen((value) => !value)}
          />
        ) : null}

        {canManage ? (
          <VendorManagerManageGrid
            navigation={navigation}
            store={store}
            myRole={myRole}
            analytics={analyticsQ.data}
            analyticsStale={analyticsQ.isError}
            analyticsUpdatedAt={analyticsQ.dataUpdatedAt}
          />
        ) : (
          <VendorStaffAvailability navigation={navigation} />
        )}

        {/* Store status. In §B preview the controls are honestly locked — the
            server refuses commerce-on for an unverified business anyway. */}
        <Card style={{ marginBottom: space.lg }}>
          {/* Open/close is MANAGER-only server-side. The whole 48pt row owns
              the switch semantics so the control is named and easy to hit. */}
          {surface.canToggleOpen ? (
            <Pressable
              disabled={inPreview || toggleOpen.isPending}
              onPress={() => toggleOpen.mutate()}
              accessibilityRole="switch"
              accessibilityLabel="Store open to customers"
              accessibilityHint={open ? 'Close the store to new customers' : 'Open the store to new customers'}
              accessibilityState={{ checked: !inPreview && open, disabled: inPreview || toggleOpen.isPending, busy: toggleOpen.isPending }}
            >
              {({ pressed }) => (
                <View style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', opacity: pressed ? 0.82 : 1 }}>
                  {storeStatusText}
                  <AvailabilitySwitch value={!inPreview && open} disabled={inPreview || toggleOpen.isPending} accessible={false} pointerEvents="none" />
                </View>
              )}
            </Pressable>
          ) : (
            <View style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center' }}>{storeStatusText}</View>
          )}
          {toggleOpen.isError ? (
            <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
              Store status didn’t update — check your connection and try again.
            </T>
          ) : null}
          {!inPreview && canManage ? (
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
            <Pressable
              disabled={setSelfDelivery.isPending}
              onPress={() => setSelfDelivery.mutate(!selfDelivery)}
              accessibilityRole="switch"
              accessibilityLabel="Deliver my own orders"
              accessibilityHint={selfDelivery ? 'Use Swift riders for delivery orders' : 'Route delivery orders to this store'}
              accessibilityState={{ checked: selfDelivery, disabled: setSelfDelivery.isPending, busy: setSelfDelivery.isPending }}
            >
              {({ pressed }) => (
                <View style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', opacity: pressed ? 0.82 : 1 }}>
                  <View style={{ flex: 1, paddingRight: space.md }}>
                    <T variant="body" weight="bold">
                      Deliver my own orders
                    </T>
                    <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                      {selfDelivery
                        ? 'You deliver your orders yourself — Swift won’t send a rider.'
                        : 'Swift sends the nearest rider for your delivery orders.'}
                    </T>
                  </View>
                  <AvailabilitySwitch value={selfDelivery} disabled={setSelfDelivery.isPending} accessible={false} pointerEvents="none" />
                </View>
              )}
            </Pressable>
            {setSelfDelivery.isError ? (
              <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
                Couldn’t update — try again.
              </T>
            ) : null}
          </Card>
        ) : null}

        <T variant="caption" tone="muted" center style={{ marginBottom: space.xl }}>
          You keep 100% of every order — Swift takes no commission.
        </T>

      </ScrollView>
    </Screen>
  );
}

function VendorBillingSuspended({ store, stores, myRole }: { store: any; stores: any[]; myRole?: VendorMemberRole }) {
  const navigation = useNavigation<any>();
  const qc = useQueryClient();
  const setSelectedStore = useStoreSwitcher((state) => state.setSelectedStore);
  const [switchingStore, setSwitchingStore] = useState(false);
  const isOwner = myRole === 'OWNER';
  const subQ = useVendorSubscription(isOwner);
  const sub = subQ.data ?? (isOwner ? store?.subscription : null);
  const blockedSub = ['SUSPENDED', 'CHURNED'].includes(String(sub?.status ?? '').toUpperCase());
  const switchStore = async (id: string) => {
    if (id === store.id || switchingStore) return;
    setSwitchingStore(true);
    disconnectSocket();
    setSelectedStore(id);
    try {
      await Promise.all([
        qc.resetQueries({ queryKey: ['vendor'] }),
        qc.resetQueries({ queryKey: ['verification'] }),
      ]);
    } finally {
      setSwitchingStore(false);
    }
  };

  return (
    <Screen>
      <TabHeader title={store.name} eyebrow="ACCOUNT PAUSED · ORDERS OFF" statusTone="warning" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={switchingStore || subQ.isRefetching}
            onRefresh={() => {
              if (isOwner) subQ.refetch();
              void qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
            }}
            tintColor={color.brand[500]}
          />
        }
      >
        {stores.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, marginBottom: space.lg }}>
            {stores.map((candidate) => (
              <Chip
                key={candidate.id}
                label={candidate.name}
                selected={candidate.id === store.id}
                onPress={() => void switchStore(candidate.id)}
              />
            ))}
          </ScrollView>
        ) : null}

        <View style={{ alignItems: 'center', paddingHorizontal: space.lg, marginBottom: space.lg }}>
          <View
            style={{
              width: space['5xl'] + space.lg,
              height: space['5xl'] + space.lg,
              borderRadius: radius.full,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: color.soft.warning,
            }}
          >
            <MaterialCommunityIcons name="store-alert-outline" size={30} color={color.warning} />
          </View>
          <T variant="title" center style={{ marginTop: space.lg }}>
            New orders are paused
          </T>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
            {isOwner
              ? 'The weekly fee needs attention. Pay with the store’s Swift Number; confirmation clears the billing hold. Any separate verification hold still needs its own fix.'
              : 'The store’s weekly fee needs attention. Ask the owner to pay with the store’s Swift Number; only the owner can access billing.'}
          </T>
        </View>

        {switchingStore || (isOwner && subQ.isLoading && !sub) ? (
          <LoadingBlock />
        ) : isOwner && blockedSub ? (
          <>
            {subQ.isError ? (
              <T variant="caption" tone="muted" center style={{ marginBottom: space.sm }}>
                Showing the last loaded billing status — pull to retry.
              </T>
            ) : null}
            <VendorBillingNotice sub={sub} onPay={() => navigation.navigate('VendorMySwiftNumber')} />
          </>
        ) : isOwner ? (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="label" weight="semibold">
              Billing details are unavailable
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              The store is still paused. Use your Swift Number to check the cash/MMG payment steps; pull down to retry this status.
            </T>
            <PillButton
              label="How to pay"
              icon="hash"
              size="md"
              style={{ marginTop: space.md }}
              onPress={() => navigation.navigate('VendorMySwiftNumber')}
            />
          </Card>
        ) : (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="label" weight="semibold">
              Owner action required
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              You can return to the queue when the owner’s payment is confirmed and the store is active again.
            </T>
          </Card>
        )}

        <T variant="caption" tone="muted" center>
          Swift never takes commission. The weekly fee is separate from customer order money.
        </T>
      </ScrollView>
    </Screen>
  );
}

function VendorLiveOrderLayer({ vendorId }: { vendorId: string }) {
  const { takeover, dismissTakeover } = useVendorOrdersLive(vendorId);
  return takeover.length > 0 ? <NewOrderTakeover queue={takeover} onDismiss={dismissTakeover} /> : null;
}

function VendorWentLiveLayer({ status }: { status: string }) {
  const approvalLive = status === 'ACTIVE' ? true : status === 'PENDING_APPROVAL' ? false : undefined;
  const live = useWentLive(approvalLive);
  return <WentLivePopup visible={live.celebrate} onClose={live.dismiss} kind="vendor" />;
}

function VendorRoot() {
  const { owner, store, stores, isLoading } = useVendorProfile();
  const qc = useQueryClient();
  const myRole = safeVendorRole(owner?.myRole);
  const selectedStoreId = useStoreSwitcher((s) => s.selectedStoreId);
  const setSelectedStore = useStoreSwitcher((s) => s.setSelectedStore);
  const [repairingSelection, setRepairingSelection] = useState(false);
  const { preview, previewType, enterPreview, exitPreview } = useVendorPreview();
  // Preview is a per-store choice: switching stores lands on that store's
  // real state (checklist for pending, board for live) — never a stale peek.
  // BUT the unauthenticated sample preview (previewType set) has one synthetic
  // store; don't tear it down on its own mount.
  useEffect(() => {
    if (!previewType) exitPreview();
  }, [store?.id, exitPreview, previewType]);
  // Make the default store an EXPLICIT selection before the tabs mount: every
  // vendor request then carries x-vendor-id, so the order board, menu and
  // insights all scope to the store named in the header (a stale id from a
  // previous session gets re-pointed to a store this account actually has).
  const validSelection = !!selectedStoreId && stores.some((s: any) => s.id === selectedStoreId);
  useEffect(() => {
    if (stores.length === 0 || validSelection) return;
    const nextStoreId = stores[0].id;
    if (!selectedStoreId) {
      setSelectedStore(nextStoreId);
      return;
    }
    // A selected membership disappeared (or belongs to an earlier account).
    // Treat this like an explicit store handoff: leave the socket room and
    // discard every store-bound cache before mounting the fallback business.
    setRepairingSelection(true);
    disconnectSocket();
    setSelectedStore(nextStoreId);
    void Promise.all([
      qc.resetQueries({ queryKey: ['vendor'] }),
      qc.resetQueries({ queryKey: ['verification'] }),
    ]).finally(() => setRepairingSelection(false));
  }, [stores, validSelection, selectedStoreId, setSelectedStore, qc]);

  useEffect(() => {
    if (store) track('vendor_suite_opened', { vendorType: String(store.vendorType ?? '') });
  }, [store?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || repairingSelection || (stores.length > 0 && !validSelection)) {
    return (
      <Screen>
        <LoadingBlock />
      </Screen>
    );
  }
  if (!store) return <BusinessSetup />;
  const suspensionSource = store.suspensionSource == null ? null : String(store.suspensionSource).toUpperCase();
  const subscriptionBlocked = ['SUSPENDED', 'CHURNED'].includes(String(store.subscription?.status ?? '').toUpperCase());
  const billingSuspended =
    store.status === 'SUSPENDED' &&
    (suspensionSource === 'BILLING' || (suspensionSource === null && subscriptionBlocked));
  return (
    <>
      {billingSuspended ? (
        <VendorBillingSuspended store={store} stores={stores} myRole={myRole} />
      ) : store.status !== 'ACTIVE' && !preview ? (
        <VendorOnboarding store={store} onPreview={enterPreview} />
      ) : (
        <VendorTabs />
      )}
      {/* Per-store keying prevents an ordinary A→B switch from masquerading
          as B's approval moment. A real status flip within one store persists.
          The key is PREFIXED because these two layers are siblings: keyed on the
          bare store id they collide with each other on every vendor session, and
          React's response to duplicate sibling keys is explicitly unspecified —
          which would put the remount this comment relies on at its mercy. */}
      <VendorWentLiveLayer key={`went-live-${store.id}`} status={String(store.status ?? '')} />
      {/* Keying this layer by store also clears queued alerts during a store
          handoff; the old socket is disconnected before the cache reset. */}
      {store.status === 'ACTIVE' ? <VendorLiveOrderLayer key={`live-orders-${store.id}`} vendorId={store.id} /> : null}
    </>
  );
}

// ─── Menu management ─────────────────────────────────────────────────────────

function MenuItemRow({
  item,
  navigation,
  categories,
  canEdit,
}: {
  item: any;
  navigation: any;
  categories: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const setAvail = useSetItemAvailability();
  const del = useDeleteItem();
  const serverAvailable = item.isAvailable !== false;
  const [markedAvailable, setMarkedAvailable] = useState(serverAvailable);
  useEffect(() => setMarkedAvailable(serverAvailable), [serverAvailable]);
  const tracksStock = item.stockQuantity != null;
  const outOfStock = tracksStock && item.stockQuantity <= 0;
  const soldOut = !markedAvailable;
  const lowStock =
    markedAvailable &&
    !outOfStock &&
    tracksStock &&
    item.lowStockThreshold != null &&
    item.stockQuantity <= item.lowStockThreshold;
  const availabilityDisabled = readOnly || setAvail.isPending;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ordered = numericFact(item.totalOrdered);
  const stockDetail = outOfStock
    ? '0 left'
    : lowStock
      ? `${item.stockQuantity} left · alert at ${item.lowStockThreshold}`
      : tracksStock
        ? `${item.stockQuantity} in stock`
        : null;
  const itemDetail = [ordered == null ? null : `${ordered} orders placed`, stockDetail].filter(Boolean).join(' · ');
  const toggleAvailability = () => {
    const next = !markedAvailable;
    setMarkedAvailable(next);
    setAvail.mutate(
      { id: item.id, isAvailable: next },
      { onError: () => setMarkedAvailable(!next) },
    );
  };

  return (
    <Card style={{ marginBottom: space.md, backgroundColor: soldOut || outOfStock ? color.soft.warning : color.surface.base }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
        <View style={{ opacity: soldOut ? 0.55 : 1 }}>
          {item.imageUrl ? (
            <Image
              source={{ uri: mediaUrl(item.imageUrl)! }}
              style={{ width: space['5xl'], height: space['5xl'], borderRadius: radius.md }}
              contentFit="cover"
              accessibilityLabel={`${item.name} photo`}
            />
          ) : (
            <View
              style={{
                width: space['5xl'],
                height: space['5xl'],
                borderRadius: radius.md,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: color.brand[50],
              }}
            >
              <Feather name="image" size={18} color={color.text.muted} />
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md, opacity: soldOut ? 0.62 : 1 }}>
            <T variant="heading" numberOfLines={2} style={{ flex: 1 }}>
              {item.name}
            </T>
            <T variant="numM" numberOfLines={1}>
              {money(item.basePrice)}
            </T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm }}>
            {soldOut ? <TonePill label="SOLD OUT" tone="warning" /> : null}
            {outOfStock ? <TonePill label="0 LEFT" tone="warning" /> : null}
            {lowStock ? <TonePill label={`${item.stockQuantity} LEFT`} tone="warning" /> : null}
            {itemDetail ? (
              <T variant="caption" tone="muted" style={{ flexShrink: 1 }}>
                {itemDetail}
              </T>
            ) : null}
          </View>
        </View>
      </View>

      <Pressable
        disabled={availabilityDisabled}
        onPress={toggleAvailability}
        accessibilityRole="switch"
        accessibilityLabel={`${item.name} availability`}
        accessibilityHint={
          soldOut
              ? 'Make this item available to customers'
              : 'Mark this item sold out for new orders'
        }
        accessibilityState={{ checked: markedAvailable, disabled: availabilityDisabled, busy: setAvail.isPending }}
        style={{
          minHeight: space['5xl'],
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.md,
          marginTop: space.md,
          paddingHorizontal: space.md,
          borderRadius: radius.md,
          backgroundColor: soldOut || outOfStock ? color.surface.base : color.brand[50],
        }}
      >
        <View style={{ flex: 1, paddingVertical: space.sm }}>
          <T variant="label" weight="semibold" tone={soldOut || outOfStock ? 'warning' : 'deep'}>
            {soldOut ? 'Hidden from new orders' : outOfStock ? 'Visible, but can’t be ordered' : 'Available to customers'}
          </T>
          <T variant="caption" tone="muted">
            {soldOut
              ? 'Customers can’t add this to a new order.'
              : outOfStock
                ? 'Stock is zero. Switch off to hide it, or restock it.'
                : 'Switch off to stop new customers adding it.'}
          </T>
        </View>
        <AvailabilitySwitch
          value={markedAvailable}
          disabled={availabilityDisabled}
          accessible={false}
          pointerEvents="none"
        />
      </Pressable>

      {setAvail.isError ? (
        <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
          Availability didn’t update — check your connection and try again.
        </T>
      ) : null}

      {canEdit ? (
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          <PillButton
            label="Edit item"
            variant="soft"
            size="md"
            style={{ flex: 1 }}
            onPress={() => navigation.navigate('VendorItemEditor', { item, categories })}
          />
          <PillButton
            label="Delete"
            variant="outline"
            size="md"
            style={{ flex: 1 }}
            loading={del.isPending}
            disabled={readOnly}
            onPress={() => setConfirmDelete(true)}
          />
        </View>
      ) : null}

      <PopupCard visible={canEdit && confirmDelete} onClose={() => setConfirmDelete(false)}>
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
            if (readOnly || !canEdit) return;
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
  const cells: { label: string; value: number; tone: 'ink' | 'warning' | 'muted' }[] = [
    { label: 'In stock', value: s.inStock, tone: 'ink' },
    { label: 'Low', value: s.lowStock, tone: s.lowStock > 0 ? 'warning' : 'muted' },
    { label: 'Out', value: s.outOfStock, tone: s.outOfStock > 0 ? 'warning' : 'muted' },
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
      {low.slice(0, 4).map((i: any) => {
        const status = i.stockQuantity <= 0
          ? i.isAvailable === false
            ? '0 left · sold out'
            : '0 left · switch off'
          : `${i.stockQuantity} left`;
        return (
          <Pressable
            key={i.id}
            onPress={() => navigation.navigate('VendorItemEditor', { item: i, categories: catOptions })}
            accessibilityRole="button"
            accessibilityLabel={`${i.name}. ${status}`}
            accessibilityHint="Open the item editor"
          >
            {({ pressed }) => (
              <View style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
                <T variant="label" numberOfLines={1} style={{ flex: 1, paddingRight: space.md }}>
                  {i.name}
                </T>
                <T variant="label" weight="semibold" tone={i.stockQuantity <= 0 ? 'warning' : 'ink'}>
                  {status}
                </T>
                <Feather name="chevron-right" size={14} color={color.text.muted} style={{ marginLeft: space.xs }} />
              </View>
            )}
          </Pressable>
        );
      })}
      {low.length > 4 ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
          +{low.length - 4} more below their alert level
        </T>
      ) : null}
    </View>
  );
}

/** Category heading with manager controls; staff receive the same factual heading
 *  without authoring affordances. */
function CategoryHeader({ cat, canEdit }: { cat: any; canEdit: boolean }) {
  const readOnly = !!useVendorPreview((state) => state.previewType);
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>(cat.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const itemCount = (cat.items ?? []).length;

  const saveName = () => {
    if (readOnly || !canEdit) return;
    const n = name.trim();
    if (!n || n === cat.name) {
      setEditing(false);
      setName(cat.name);
      return;
    }
    updateCategory.mutate({ id: cat.id, data: { name: n } }, { onSuccess: () => setEditing(false) });
  };

  if (editing && canEdit) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md }}>
        <InlineInput style={{ flex: 1 }} value={name} onChangeText={setName} placeholder="Category name" />
        <PillButton label="Save" size="md" loading={updateCategory.isPending} disabled={!name.trim()} onPress={saveName} />
        <PillButton
          label="Cancel"
          variant="soft"
          size="md"
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
      <T variant="caption" tone="muted" style={{ marginRight: canEdit ? space.sm : 0 }}>
        {itemCount} item{itemCount === 1 ? '' : 's'}
      </T>
      {canEdit ? (
        <>
          <Pressable
            disabled={readOnly}
            onPress={() => setEditing(true)}
            accessibilityRole="button"
            accessibilityLabel={`Rename ${cat.name}`}
            accessibilityState={{ disabled: readOnly }}
          >
            {({ pressed }) => (
              <View style={{ width: space['5xl'], height: space['5xl'], alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
                <Feather name="edit-2" size={16} color={color.text.muted} />
              </View>
            )}
          </Pressable>
          <Pressable
            disabled={readOnly}
            onPress={() => setConfirmDelete(true)}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${cat.name}`}
            accessibilityState={{ disabled: readOnly }}
          >
            {({ pressed }) => (
              <View style={{ width: space['5xl'], height: space['5xl'], alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 }}>
                <Feather name="trash-2" size={16} color={color.text.muted} />
              </View>
            )}
          </Pressable>
        </>
      ) : null}

      <PopupCard visible={canEdit && confirmDelete} onClose={() => setConfirmDelete(false)}>
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
            if (readOnly || !canEdit) return;
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
  const { owner, store } = useVendorProfile();
  const myRole = safeVendorRole(owner?.myRole);
  const canEdit = myRole === 'OWNER' || myRole === 'MANAGER';
  const cat = catalogueMeta(store?.vendorType); // R1: title + prompts named for the type
  const [newCat, setNewCat] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const categories: any[] = menuQ.data ?? [];
  const catOptions = categories.map((c) => ({ id: c.id, name: c.name }));
  const allItems = categories.flatMap((category) => category.items ?? []);
  const soldOutCount = allItems.filter((item: any) => item.isAvailable === false).length;
  const activeCount = Math.max(0, allItems.length - soldOutCount);
  const visibleCategories = selectedCategoryId
    ? categories.filter((category) => category.id === selectedCategoryId)
    : categories;
  const selectedCategoryExists = !selectedCategoryId || categories.some((category) => category.id === selectedCategoryId);

  useEffect(() => {
    if (!selectedCategoryExists) setSelectedCategoryId(null);
  }, [selectedCategoryExists]);

  const addCategory = () => {
    if (readOnly || !canEdit) return;
    const name = newCat.trim();
    if (name.length < 1) return;
    createCategory.mutate(
      { name },
      {
        onSuccess: () => {
          setNewCat('');
          setAddingCategory(false);
        },
      },
    );
  };

  return (
    <Screen>
      <SubHeader title={canEdit ? cat.label : 'Availability'} navigation={navigation} hideBack />
      {menuQ.isLoading ? (
        <LoadingBlock />
      ) : menuQ.isError && !menuQ.data ? (
        <ErrorState message="We couldn't load your live catalogue. Check your connection and try again." onRetry={() => menuQ.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={menuQ.isRefetching} onRefresh={() => menuQ.refetch()} tintColor={color.brand[500]} />}
        >
          {menuQ.isError && menuQ.data ? (
            <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
              Showing the last loaded catalogue — refresh did not complete.
            </T>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md, marginBottom: space.lg }}>
            <View style={{ flex: 1 }}>
              <T variant="micro" tone="muted">
                LIVE CATALOGUE
              </T>
              <T variant="heading" style={{ marginTop: space.xs }}>
                {activeCount} active · {soldOutCount} sold out
              </T>
            </View>
            {soldOutCount > 0 ? <TonePill label={`${soldOutCount} SOLD OUT`} tone="warning" /> : null}
          </View>

          {canEdit ? (
            <>
              <View style={{ flexDirection: 'row', gap: space.md, marginBottom: space.md }}>
                <PillButton
                  label="Bulk import"
                  icon="upload-cloud"
                  variant="outline"
                  size="md"
                  style={{ flex: 1 }}
                  disabled={readOnly}
                  onPress={() => navigation.navigate('VendorBulkImport')}
                />
                <PillButton
                  label="Add item"
                  icon="plus"
                  size="md"
                  style={{ flex: 1 }}
                  disabled={readOnly || catOptions.length === 0}
                  onPress={() => navigation.navigate('VendorItemEditor', { categories: catOptions })}
                />
              </View>
              {catOptions.length === 0 ? (
                <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
                  Add a section first, then add individual items.
                </T>
              ) : null}
            </>
          ) : (
            <T variant="caption" tone="muted" style={{ marginBottom: space.lg }}>
              Floor access: switch items on or sold out. Editing stays with a manager or owner.
            </T>
          )}

          {categories.length > 0 ? (
            <View style={{ marginBottom: space.lg }}>
              <T variant="micro" tone="muted" style={{ marginBottom: space.sm }}>
                SECTIONS
              </T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
                <Chip
                  label={`All · ${allItems.length}`}
                  selected={selectedCategoryId === null}
                  onPress={() => setSelectedCategoryId(null)}
                />
                {categories.map((category) => (
                  <Chip
                    key={category.id}
                    label={`${category.name} · ${(category.items ?? []).length}`}
                    selected={selectedCategoryId === category.id}
                    onPress={() => setSelectedCategoryId(category.id)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {/* Inventory-first: goods vendors lead with stock health (self-hides
              for restaurants/services, which don't track stock). */}
          <InventorySummaryCard categories={categories} />

          {canEdit ? (
            <View style={{ marginBottom: space.lg }}>
              {addingCategory ? (
                <Card>
                  <T variant="label" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                    New section
                  </T>
                  <InlineInput value={newCat} onChangeText={setNewCat} placeholder={cat.catPlaceholder} />
                  <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                    <PillButton
                      label="Add section"
                      size="md"
                      style={{ flex: 1 }}
                      loading={createCategory.isPending}
                      disabled={readOnly || newCat.trim().length < 1}
                      onPress={addCategory}
                    />
                    <PillButton label="Cancel" variant="soft" size="md" style={{ flex: 1 }} onPress={() => setAddingCategory(false)} />
                  </View>
                </Card>
              ) : (
                <PillButton label="Add section" variant="soft" size="md" onPress={() => setAddingCategory(true)} />
              )}
            </View>
          ) : null}

          {canEdit ? <LowStockCard categories={categories} navigation={navigation} catOptions={catOptions} /> : null}

          {categories.length === 0 ? (
            <EmptyState
              icon="book-open"
              title={canEdit ? `Build your ${cat.label.toLowerCase()}` : 'No items to update'}
              body={canEdit ? 'Add a section, then start adding items.' : 'A manager or owner needs to add the first item.'}
            />
          ) : (
            visibleCategories.map((category) => (
              <View key={category.id} style={{ marginBottom: space.lg }}>
                <CategoryHeader cat={category} canEdit={canEdit} />
                {(category.items ?? []).length === 0 ? (
                  <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
                    No items yet.
                  </T>
                ) : (
                  category.items.map((item: any) => (
                    <MenuItemRow
                      key={item.id}
                      item={item}
                      navigation={navigation}
                      categories={catOptions}
                      canEdit={canEdit}
                    />
                  ))
                )}
              </View>
            ))
          )}

          {categories.length > 0 ? (
            <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
              Switching an item off stops it being added to new orders. Existing orders are never silently changed.
            </T>
          ) : null}
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
  // [G2] The load hint dispatch needs to keep a 20 kg rice bag off a bicycle.
  // Three words, never units: the server maps them. An item saved before the
  // field existed reads as normal, which is exactly how it has always behaved.
  const [bulk, setBulk] = useState<'normal' | 'bulky' | 'very_bulky'>(existing?.bulk ?? 'normal');
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
              bulk,
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
        // [WR-034] The item is durable but the vendor must KNOW the photo
        // didn't make it — a silent miss ships a photo-less listing.
        toast.show("Item saved, but the photo didn't upload — open the item and add it again.");
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
              {/* How big is one of these to carry? Riders on bicycles cannot take
                  a very bulky order, and dispatch uses this to keep it off them.
                  A choice, not a number — nobody should be asked to think in units. */}
              <View>
                <T variant="caption" weight="semibold" tone="muted" style={{ marginBottom: space.sm }}>
                  How bulky is one of these to carry?
                </T>
                <Segmented
                  options={[
                    { key: 'normal', label: 'Normal' },
                    { key: 'bulky', label: 'Bulky' },
                    { key: 'very_bulky', label: 'Very bulky' },
                  ] as const}
                  value={bulk}
                  onChange={setBulk}
                />
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  {bulk === 'very_bulky'
                    ? 'Like a 20 kg bag of rice or a case of water. Only riders with a bigger vehicle will be offered it.'
                    : bulk === 'bulky'
                      ? 'Like a crate of drinks or a large box.'
                      : 'Fits in a delivery bag with room to spare.'}
                </T>
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

/** Owned single-brand chart. Bars are decorative; the parent revenue sentence is
 * the accessible numerical summary, so a screen reader never walks 90 glyphs. */
function RevenueChart({ daily }: { daily: RevenueDay[] }) {
  const chartHeight = space['5xl'] + space['5xl'];
  const peak = Math.max(...daily.map((day) => day.revenue), 0);
  const scaleMax = Math.max(peak, 1);
  const today = daily.find((day) => day.isToday);
  const shortLabel = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(0, 1).toUpperCase();
    return 'SMTWTFS'[new Date(`${value}T12:00:00Z`).getUTCDay()]!;
  };
  const dateLabel = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(`${value}T12:00:00Z`);
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  };
  const chartGap = daily.length <= 7 ? space.sm : daily.length <= 30 ? space.xs : undefined;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Revenue trend for ${daily.length} days. Peak ${money(peak)}${today ? `. Today ${money(today.revenue)}` : ''}.`}
      style={{ marginTop: space.lg }}
    >
      {today ? (
        <T variant="caption" weight="semibold" tone="brand" style={{ alignSelf: 'flex-end', marginBottom: space.sm }}>
          Today {money(today.revenue)}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: chartGap, height: chartHeight }} importantForAccessibility="no-hide-descendants">
        {daily.map((day) => (
          <View
            key={day.date}
            style={{
              flex: 1,
              borderTopLeftRadius: radius.sm,
              borderTopRightRadius: radius.sm,
              height: Math.max(space.xs, Math.round((day.revenue / scaleMax) * chartHeight)),
              backgroundColor: day.revenue > 0 ? color.brand[500] : color.border.subtle,
              opacity: day.isToday ? 1 : 0.78,
            }}
          />
        ))}
      </View>
      {daily.length <= 7 ? (
        <View style={{ flexDirection: 'row', gap: chartGap, marginTop: space.sm }} importantForAccessibility="no-hide-descendants">
          {daily.map((day) => (
            <View key={day.date} style={{ flex: 1, alignItems: 'center' }}>
              <T variant="caption" weight={day.isToday ? 'bold' : 'medium'} tone={day.isToday ? 'brand' : 'muted'}>
                {shortLabel(day.date)}
              </T>
            </View>
          ))}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm }} importantForAccessibility="no-hide-descendants">
          <T variant="caption" tone="muted">
            {dateLabel(daily[0]!.date)}
          </T>
          <T variant="caption" tone="muted">
            peak {money(peak)}
          </T>
          <T variant="caption" tone="muted">
            {dateLabel(daily[daily.length - 1]!.date)}
          </T>
        </View>
      )}
    </View>
  );
}

function TopItemsCard({ items, sample }: { items: any[]; sample: boolean }) {
  const ranked = items.filter((item) => {
    const lifetime = numericFact(item.totalOrdered) ?? 0;
    const recent = numericFact(item.recentOrders ?? item.count) ?? 0;
    return lifetime > 0 || recent > 0;
  });
  const lifetimeRank = !sample;
  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="micro" tone="muted">
        {lifetimeRank ? 'MOST ORDERED · LIFETIME' : 'POPULAR ITEMS · SAMPLE'}
      </T>
      {lifetimeRank ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Ranked by all-time orders placed; the second count is quantity ordered in the last 30 days.
        </T>
      ) : null}
      {ranked.length === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Your most-ordered items will rank here once orders come in.
        </T>
      ) : (
        ranked.map((item, i) => (
          <View key={item.id ?? `${item.name}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.md }}>
            <T variant="numM" tone="brand" style={{ width: space['2xl'] }}>
              {i + 1}
            </T>
            {item.imageUrl ? (
              <Image
                source={{ uri: mediaUrl(item.imageUrl)! }}
                style={{ width: space['4xl'], height: space['4xl'], borderRadius: radius.sm }}
                contentFit="cover"
                accessibilityLabel={`${item.name} photo`}
              />
            ) : (
              <View style={{ width: space['4xl'], height: space['4xl'], borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
                <Feather name="image" size={14} color={color.text.muted} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: space.sm }}>
              <T variant="label" weight="semibold" numberOfLines={1}>
                {item.name}
              </T>
              <T variant="caption" tone="muted">
                {item.category?.name ?? 'Catalogue item'}
              </T>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              {numericFact(item.totalOrdered) != null ? (
                <T variant="label" weight="semibold">
                  {numericFact(item.totalOrdered)} orders
                </T>
              ) : null}
              {numericFact(item.recentOrders ?? item.count) != null ? (
                <T variant="caption" tone="muted">
                  {numericFact(item.recentOrders ?? item.count)} {lifetimeRank ? 'ordered in 30d' : 'sample orders'}
                </T>
              ) : null}
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
  const hours: Array<{ hour: number; orders: number }> = Array.isArray(data) ? data : data.hours ?? [];
  if (hours.length === 0) return null;
  const total = numericFact((data as any).total) ?? hours.reduce((sum, hour) => sum + Number(hour.orders ?? 0), 0);
  const peak = (data as any).peak ?? hours.reduce((best, hour) => (hour.orders > best.orders ? hour : best), hours[0]!);
  const max = Math.max(...hours.map((h) => h.orders), 1);
  const chartHeight = space['5xl'] + space.lg;
  const fmtHour = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
  const axisHours = hours.length <= 8
    ? hours
    : [0, 0.25, 0.5, 0.75, 1].map((fraction) => hours[Math.round((hours.length - 1) * fraction)]!);
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <T variant="body" weight="semibold">
          Busy hours
        </T>
        {total > 0 ? (
          <T variant="label" tone="muted">
            peak {fmtHour(peak.hour)}
          </T>
        ) : null}
      </View>
      {total === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Order times will map out here — staff up for the rush.
        </T>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.xs, height: chartHeight, marginTop: space.md }}>
            {hours.map((h) => (
              <View
                key={h.hour}
                style={{
                  flex: 1,
                  borderTopLeftRadius: radius.sm,
                  borderTopRightRadius: radius.sm,
                  height: Math.max(space.xs, Math.round((h.orders / max) * chartHeight)),
                  backgroundColor: h.orders > 0 ? color.brand[500] : color.border.subtle,
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm }}>
            {axisHours.map((entry, index) => (
              <T key={`${entry.hour}-${index}`} variant="caption" tone="muted">
                {fmtHour(entry.hour)}
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
  if (reviewsQ.isError && !reviewsQ.data) {
    return (
      <Card style={{ marginBottom: space.md }}>
        <T variant="body" weight="semibold">
          Recent reviews
        </T>
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Reviews are unavailable right now.
        </T>
        <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.sm }} onPress={() => reviewsQ.refetch()} />
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: space.md }}>
      <T variant="body" weight="semibold">
        Recent reviews
      </T>
      {reviewsQ.isError ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Showing the last loaded reviews — refresh did not complete.
        </T>
      ) : null}
      {reviews.length === 0 ? (
        <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
          Reviews land here after customers rate their orders.
        </T>
      ) : (
        reviews.map((r) => (
          <View key={r.id} style={{ marginTop: space.sm, borderTopWidth: 1, borderTopColor: color.border.subtle, paddingTop: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <T variant="label" weight="semibold" style={{ flex: 1 }}>
                  {r.rater?.firstName ?? 'Customer'} · <T variant="label" tone="star">{'★'.repeat(Number(r.score) || 0)}</T>
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
function RatingsCard({ lifetimeOrders }: { lifetimeOrders: number | null }) {
  const reviewsQ = useMyStoreReviews();
  const summary = reviewsQ.data?.summary;
  if (!summary || !summary.totalReviews) return null;
  const dist = summary.distribution ?? {};
  const max = Math.max(...[1, 2, 3, 4, 5].map((s) => Number(dist[String(s)] ?? 0)), 1);
  return (
    <Card style={{ marginBottom: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.md }}>
        <T variant="micro" tone="muted">
          RATINGS
        </T>
        {lifetimeOrders != null ? (
          <T variant="caption" tone="muted">
            {lifetimeOrders} lifetime orders
          </T>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: space.xl }}>
        <View style={{ alignItems: 'center', justifyContent: 'center', minWidth: space['5xl'] + space['4xl'] }}>
          <T variant="display">{Number(summary.averageRating).toFixed(1)}</T>
          <View style={{ flexDirection: 'row', gap: space.xs, marginTop: space.xs }}>
            {[1, 2, 3, 4, 5].map((s) => (
              <MaterialCommunityIcons
                key={s}
                name={Number(summary.averageRating) >= s - 0.25 ? 'star' : 'star-outline'}
                size={13}
                color={color.star}
              />
            ))}
          </View>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
            {summary.totalReviews} rating{summary.totalReviews === 1 ? '' : 's'}
          </T>
        </View>
        <View style={{ flex: 1, justifyContent: 'center', gap: space.xs }}>
          {[5, 4, 3, 2, 1].map((s) => {
            const n = Number(dist[String(s)] ?? 0);
            return (
              <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <T variant="caption" tone="muted" style={{ width: space.md, textAlign: 'right' }}>
                  {s}
                </T>
                <View style={{ flex: 1, height: space.sm, borderRadius: radius.sm, backgroundColor: color.border.subtle, overflow: 'hidden' }}>
                  <View style={{ width: `${Math.round((n / max) * 100)}%`, height: space.sm, borderRadius: radius.sm, backgroundColor: n > 0 ? color.star : 'transparent' }} />
                </View>
                <T variant="caption" tone="muted" style={{ width: space.xl }}>
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
function OpsCard({ ops, period, stale }: { ops: any; period: number; stale?: boolean }) {
  if (!ops || !ops.placedOrders) return null;
  const prepDelta =
    ops.avgPrepMinutes != null && ops.avgQuotedPrepMinutes != null
      ? Math.round((ops.avgPrepMinutes - ops.avgQuotedPrepMinutes) * 10) / 10
      : null;
  return (
    <Card style={{ marginBottom: space.lg }}>
      <T variant="body" weight="bold">
        Operations · rolling {period}d
      </T>
      {stale ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          Showing the last loaded operations figures — refresh did not complete.
        </T>
      ) : null}
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
function windowTotals(daily: RevenueDay[], take: number) {
  const safeTake = Math.max(0, Math.min(take, daily.length));
  const sumRevenue = (rows: RevenueDay[]) => rows.reduce((sum, day) => sum + day.revenue, 0);
  const sumOrders = (rows: RevenueDay[]) =>
    rows.every((day) => numericFact(day.orders) != null)
      ? rows.reduce((sum, day) => sum + Number(day.orders), 0)
      : null;
  const cur = safeTake > 0 ? daily.slice(-safeTake) : [];
  const prevRows = daily.slice(-take * 2, -take);
  const datedSeries = daily.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date));
  const previousComplete = !datedSeries || hasTrailingGuyanaDays(daily, take * 2);
  const prev = take > 0 && prevRows.length === take && previousComplete
    ? { revenue: sumRevenue(prevRows), orders: sumOrders(prevRows) }
    : null;
  return { curDaily: cur, cur: { revenue: sumRevenue(cur), orders: sumOrders(cur) }, prev };
}

function InsightMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <View style={{ flex: 1, borderRadius: radius.md, backgroundColor: color.surface.sunken, padding: space.md }}>
      <T variant="micro" tone="muted">
        {label}
      </T>
      <T variant="numM" numberOfLines={1} style={{ marginTop: space.xs }}>
        {value}
      </T>
      <T variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: space.xs }}>
        {detail}
      </T>
    </View>
  );
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
  const readOnly = !!useVendorPreview((state) => state.previewType);
  // Signed short-lived link (the JWT can't ride an in-app browser).
  const statement = useMutation({
    mutationFn: async () => {
      const owner = requireAuthSessionSnapshot();
      const r = await vendorApi.salesStatement(owner);
      requireAuthSessionForPrincipal(owner);
      const path = r.data?.data?.path as string;
      // [WR-033] A mint that returns no path, or a link that can't open on
      // this phone, must FAIL the mutation — the error line below is the
      // honest signal; success used to be claimed silently either way.
      if (!path) throw new Error('Statement link missing from the response.');
      const opened = await openPayLink(`${API_URL}${path}`);
      requireAuthSessionForPrincipal(owner);
      if (opened === false) throw new Error("Couldn't open the statement on this phone.");
    },
  });
  // Fetch double the window so "vs the previous N days" comes from the same
  // real series (90 is the endpoint's max — no prior window at that depth).
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(7);
  const requestedDays = period === 90 ? 90 : period * 2;
  const revenueQ = useVendorRevenue(requestedDays);
  const refetchRevenue = revenueQ.refetch;
  const revenueBehindAnalytics = !readOnly && q.dataUpdatedAt > 0 && q.dataUpdatedAt > revenueQ.dataUpdatedAt;
  useEffect(() => {
    if (!readOnly && q.dataUpdatedAt > 0) void refetchRevenue();
  }, [readOnly, q.dataUpdatedAt, requestedDays, refetchRevenue]);
  const opsQ = useVendorOps(period);
  const popularQ = usePopularItems(8);
  const a: any = q.data ?? {};
  const v: any = a.vendor ?? {};
  const daily = reconciledRevenueDays(revenueQ.data, a, requestedDays);
  const shownDays = readOnly ? Math.min(period, daily.length) : period;
  const hasFullWindow = readOnly ? shownDays > 0 : hasTrailingGuyanaDays(daily, period);
  const w = windowTotals(daily, hasFullWindow ? shownDays : 0);
  const aovCur = w.cur.orders != null && w.cur.orders > 0 ? w.cur.revenue / w.cur.orders : null;
  const aovPrev = w.prev?.orders != null && w.prev.orders > 0 ? w.prev.revenue / w.prev.orders : null;
  const acceptanceRate = numericFact(opsQ.data?.acceptanceRate);
  const cancellationRate = numericFact(opsQ.data?.cancellationRate);
  const placedOrders = numericFact(opsQ.data?.placedOrders);
  const primaryLoading = (q.isLoading && !q.data) || (revenueQ.isLoading && !revenueQ.data) || (revenueBehindAnalytics && !revenueQ.isError);
  const primaryError = (q.isError && !q.data) || (revenueQ.isError && (!revenueQ.data || revenueBehindAnalytics));
  const showingStale = (q.isError && !!q.data) || (revenueQ.isError && !!revenueQ.data);
  const refreshing = q.isRefetching || revenueQ.isRefetching || opsQ.isRefetching || popularQ.isRefetching;
  const opsDetail = readOnly
    ? 'Not included in sample'
    : opsQ.isLoading
      ? 'Loading this range'
      : opsQ.isError
        ? opsQ.data
          ? 'Last loaded · refresh failed'
          : 'Unavailable — pull to retry'
        : placedOrders === 0
          ? 'No placed orders'
          : placedOrders == null
            ? 'No rate reported'
            : `${placedOrders} placed order${placedOrders === 1 ? '' : 's'}`;
  const retryPrimary = () => {
    q.refetch();
    revenueQ.refetch();
  };

  return (
    <Screen>
      <TabHeader title="Insights" eyebrow={readOnly ? 'PREVIEW · SAMPLE DATA' : 'MONEY EARNED · GYD'} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              q.refetch();
              revenueQ.refetch();
              opsQ.refetch();
              popularQ.refetch();
            }}
            tintColor={color.brand[500]}
          />
        }
      >
        <View style={{ marginBottom: space.lg }}>
          <T variant="heading">Revenue at a glance</T>
          <T variant="label" tone="muted" style={{ marginTop: space.xs }}>
            Completed-order revenue. Swift never holds order money; cash and MMG settle peer-to-peer along the handoff.
          </T>
          {/* [Wave 3 · ref 21] A range switch is a LENS — one value is always
              selected — so it rides Segmented (raised chip on a sunken track),
              not a row of ChoiceChips. Predates the primitive; no longer. */}
          <Segmented
            options={PERIODS.map((p) => ({ key: String(p), label: `${p}d` }))}
            value={String(period)}
            onChange={(key) => setPeriod(Number(key) as (typeof PERIODS)[number])}
            style={{ marginTop: space.md }}
          />
        </View>

        {primaryLoading ? (
          <LoadingBlock />
        ) : primaryError ? (
          // [WR-032] Failed analytics must never render as zero KPIs — a zero
          // is a business fact, not a connection state.
          <ErrorState message="We couldn't load this revenue range. Check your connection and try again." onRetry={retryPrimary} />
        ) : !hasFullWindow ? (
          <ErrorState message="This revenue range is incomplete, so we won't present a partial total as the full period." onRetry={retryPrimary} />
        ) : (
          <>
            <Card style={{ marginBottom: space.lg, padding: space.xl }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
                <T variant="micro" tone="muted">
                  REVENUE · {readOnly ? `SAMPLE ${shownDays} DAYS` : `LAST ${period} DAYS`}
                </T>
                {w.prev ? <DeltaBadge cur={w.cur.revenue} prev={w.prev.revenue} /> : null}
              </View>
              <T variant="displayXl" numberOfLines={1} style={{ marginTop: space.sm }}>
                {money(w.cur.revenue)}
              </T>
              <T variant="label" tone="muted" style={{ marginTop: space.xs }}>
                {w.cur.orders == null
                  ? 'Order count is not included in this sample.'
                  : `${w.cur.orders} completed order${w.cur.orders === 1 ? '' : 's'} in this range.`}
              </T>
              {showingStale ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                  Showing the last loaded figures — refresh did not complete.
                </T>
              ) : null}
              {w.curDaily.length > 0 ? <RevenueChart daily={w.curDaily} /> : null}
              {w.cur.revenue === 0 ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
                  No completed-order revenue landed in this range.
                </T>
              ) : null}
              {w.prev ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
                  Change against the previous {period} days.
                </T>
              ) : period === 90 && !readOnly ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
                  Prior-period comparison is available at 7 and 30 days.
                </T>
              ) : null}
            </Card>

            <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
              <InsightMetric
                label="AVG ORDER"
                value={aovCur == null ? '—' : money(aovCur)}
                detail={aovCur == null ? 'Needs order count' : `${shownDays}d completed`}
              />
              <InsightMetric
                label="ACCEPTANCE"
                value={acceptanceRate == null ? '—' : `${acceptanceRate}%`}
                detail={opsDetail}
              />
              <InsightMetric
                label="CANCELLED"
                value={cancellationRate == null ? '—' : `${cancellationRate}%`}
                detail={opsDetail}
              />
            </View>

            {aovCur != null && aovPrev != null ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: -space.md, marginBottom: space.lg }}>
                <DeltaBadge cur={aovCur} prev={aovPrev} />
                <T variant="caption" tone="muted">
                  average order vs previous {period} days
                </T>
              </View>
            ) : null}

            {popularQ.isLoading && !popularQ.data ? (
              <Card style={{ marginBottom: space.md }}>
                <T variant="label" tone="muted">Loading item ranking…</T>
              </Card>
            ) : popularQ.isError && !popularQ.data ? (
              <Card style={{ marginBottom: space.md }}>
                <T variant="label" tone="muted">Item ranking is unavailable right now.</T>
                <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.sm }} onPress={() => popularQ.refetch()} />
              </Card>
            ) : (
              <>
                {popularQ.isError ? (
                  <T variant="caption" tone="muted" style={{ marginBottom: space.sm }}>
                    Showing the last loaded item ranking — refresh did not complete.
                  </T>
                ) : null}
                <TopItemsCard items={Array.isArray(popularQ.data) ? popularQ.data : []} sample={readOnly} />
              </>
            )}

            <T variant="heading" style={{ marginTop: space.md, marginBottom: space.md }}>
              Business health
            </T>
            {/* MMG cash ledger — delivery fees owed to riders (renders only when non-empty) */}
            <RiderFeesOwedCard />
            <OpsCard ops={opsQ.data} period={period} stale={opsQ.isError} />
            <BusyHoursCard />
            <RepeatCustomersCard />
            <VendorStandingSection />
            <RatingsCard lifetimeOrders={numericFact(v.totalOrders)} />
            <ReviewsCard />
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <KpiTile icon="silverware-fork-knife" value={numericFact(a.activeMenuItems) == null ? '—' : String(a.activeMenuItems)} label="Active items" />
              <KpiTile icon="calendar-month" value={numericFact(a.month?.orders) == null ? '—' : String(a.month.orders)} label="Orders / month" />
            </View>

            {/* Printable 30-day sales statement (marketplace §12) — what a
                store shows their accountant. Opens in the in-app browser. */}
            {!readOnly ? (
              <>
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
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function VendorAccountScreen() {
  const navigation = useNavigation<any>();
  const { owner, store } = useVendorProfile();
  const myRole = safeVendorRole(owner?.myRole);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const isOwner = myRole === 'OWNER';
  const isManager = myRole === 'OWNER' || myRole === 'MANAGER';
  const sub = useVendorSubscription(isOwner);
  const hoursQ = useVendorHours();
  const setHours = useSetHours();
  const qc = useQueryClient();
  const saveMmgLink = useMutation({
    mutationFn: (mmgPayUrl: string | null) => vendorApi.updateProfile({ mmgPayUrl }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }),
  });
  // The server owns what a publishable number is (a complete +592 subscriber
  // line), so a rejection is surfaced in ITS words rather than re-guessed here —
  // two opinions about a valid number is how a shopkeeper gets told their own
  // shop number is wrong for a reason that is not true.
  const [callNumberError, setCallNumberError] = useState<string | null>(null);
  const saveCallNumber = useMutation({
    mutationFn: (publicPhone: string | null) => vendorApi.updateProfile({ publicPhone }),
    onMutate: () => setCallNumberError(null),
    onSuccess: () => {
      setCallNumberError(null);
      void qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
    },
    onError: (e: any) => setCallNumberError(
      e?.response?.data?.error?.message ?? 'That number could not be saved. Check it and try again.',
    ),
  });

  const [days, setDays] = useState<DayHours[]>([]);
  useEffect(() => {
    // [WR-007] Seed the editor ONLY from a successful read. A failed fetch
    // used to fabricate seven 08:00–22:00 days here — and Save would then
    // delete/recreate the store's REAL schedule from the fabrication. The
    // default seed is legitimate only for a first-run vendor with no rows.
    if (!hoursQ.isSuccess) return;
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
  }, [hoursQ.isSuccess, hoursQ.data]);

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
          <SettingsRow icon="life-buoy" label="Get help" sub="A human answers — orders, billing, account" onPress={() => navigation.navigate('GetHelp')} />
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

        {isManager ? (
          <PublicCallNumberCard
            value={store?.publicPhone}
            saving={saveCallNumber.isPending}
            error={callNumberError}
            onSave={(p) => saveCallNumber.mutate(p)}
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
            ) : hoursQ.isError ? (
              <Card style={{ marginBottom: space.lg }}>
                <T variant="label" tone="muted">
                  Couldn&apos;t load your hours. Editing stays off so a guess never overwrites your real schedule.
                </T>
                <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.sm }} onPress={() => hoursQ.refetch()} />
              </Card>
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
        ? { label: 'Grace period', tone: 'warning' as const }
        : sub.status === 'ACTIVE'
          ? { label: 'Active', tone: 'success' as const }
          : { label: String(sub.status ?? '').toLowerCase() || 'Inactive', tone: 'neutral' as const };
  const subLine = !sub
    ? 'Not active yet'
    : sub.isTrialActive && sub.trialEndDate
      ? `Trial ends ${fmtDate(sub.trialEndDate)} · then ${money(sub.weeklyRate)}/week`
      : sub.isInGracePeriod && sub.gracePeriodEnd
        ? `Weekly fee due by ${fmtDate(sub.gracePeriodEnd)}`
        : `${money(sub.customRate ?? sub.weeklyRate)}/week${sub.nextBillingDate ? ` · next bill ${fmtDate(sub.nextBillingDate)}` : ''}`;
  return (
    <>
      <Card style={{ marginBottom: space.lg, paddingVertical: space.sm }}>
        <SettingsRow icon="calendar" label="Subscription" sub={subLine} right={<TonePill label={pill.label} tone={pill.tone} />} />
        <SettingsRow
          icon="hash"
          label="My Swift Number"
          sub="Pay the weekly fee at any MMG agent"
          onPress={() => navigation.navigate('VendorMySwiftNumber')}
        />
        {phone ? <SettingsRow icon="phone" label="Phone" right={<T variant="label" tone="muted">{phone}</T>} /> : null}
      </Card>
      {/* Only actionable billing status belongs here. A healthy account stays
          quiet; prepaid fee credit is deliberately not framed as a wallet. */}
      <VendorBillingNotice sub={sub} onPay={() => navigation.navigate('VendorMySwiftNumber')} />
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
          <Chip label="Staff · queue + availability" selected={role === 'STAFF'} onPress={() => setRole('STAFF')} />
          <Chip label="Manager" selected={role === 'MANAGER'} onPress={() => setRole('MANAGER')} />
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
  const { owner } = useVendorProfile();
  const myRole = safeVendorRole(owner?.myRole);
  const canEdit = myRole === 'OWNER' || myRole === 'MANAGER';
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="VendorMenu" component={VendorMenuScreen} />
      {canEdit ? <Stack.Screen name="VendorItemEditor" component={VendorItemEditorScreen} /> : null}
      {canEdit ? <Stack.Screen name="VendorBulkImport" component={VendorBulkImportScreen} /> : null}
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
  // Staff & roles (§4.1): floor STAFF work the order queue and the one inventory
  // action the API grants them — availability. Authoring, schedule and business
  // insights remain manager/owner surfaces.
  const { owner, store } = useVendorProfile();
  const myRole = safeVendorRole(owner?.myRole);
  const manager = myRole === 'OWNER' || myRole === 'MANAGER';
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
      {isService && manager ? (
        // R1: a Services store runs its day from a booking agenda, not the queue.
        <VTab.Screen
          name="Schedule"
          component={VendorScheduleScreen}
          options={{ tabBarLabel: 'Schedule', tabBarIcon: ({ color: c, size }) => <Feather name="calendar" size={size} color={c} /> }}
        />
      ) : null}
      <VTab.Screen
        name="Menu"
        component={MenuStackNav}
        options={{
          tabBarLabel: manager ? cat.label : 'Availability',
          tabBarIcon: ({ color: c, size }) => <Feather name={manager ? cat.icon : 'toggle-left'} size={size} color={c} />,
        }}
      />
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
      {/* [MKT G3] Where the backfill's "review your categories" push lands.
          Accepting a suggestion is what writes the tag the Market feed reads. */}
      <Stack.Screen name="VendorCategoryReview" component={VendorCategoryReviewScreen} />
      <Stack.Screen name="VendorMySwiftNumber" component={VendorSwiftNumberScreen} />
      {/* [B-support] Role-agnostic ticket screen — the vendor stack had NO
          route to a human. Registration, not a rewrite. */}
      <Stack.Screen name="GetHelp" component={GetHelpScreen} />
    </Stack.Navigator>
  );
}
