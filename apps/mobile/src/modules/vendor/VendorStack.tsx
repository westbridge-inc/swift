/** @jsxImportSource react */
import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { color } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import { ErrorState, LoadingBlock, Screen } from '../../kit';
import { VendorOrderDetailScreen } from './screens/VendorOrderDetailScreen';
import { VendorOrderHistoryScreen } from './screens/VendorOrderHistoryScreen';
import { VendorMyQrScreen } from './screens/VendorMyQrScreen';
import { VendorCategoryReviewScreen } from './screens/VendorCategoryReviewScreen';
import { GetHelpScreen } from '../profile/screens/GetHelpScreen';
import { disconnectSocket } from '../../services/socket';
import { useWentLive, WentLivePopup } from '../../components/onboarding/WentLive';
import { useVendorProfile, useVendorOrdersLive } from '../../hooks/vendorops';
import { track } from '../../lib/analytics';
import { useStoreSwitcher } from '../../stores/storeSwitcher';
import { useVendorPreview } from '../../stores/vendorPreview';
import { VendorBulkImportScreen } from './screens/VendorBulkImportScreen';
import { NewOrderTakeover } from './NewOrderTakeover';
import { catalogueMeta, safeVendorRole } from './shared';
import { billingBlocked } from '../../lib/vendorProfile';
import { BusinessSetup, VendorOnboarding } from './screens/BusinessSetup';
import { VendorSwiftNumberScreen } from './screens/VendorSwiftNumberScreen';
import { VendorOps } from './screens/VendorOps';
import { VendorBillingSuspended } from './screens/VendorBillingSuspended';
import { VendorMenuScreen } from './screens/VendorMenuScreen';
import { VendorItemEditorScreen } from './screens/VendorItemEditorScreen';
import { VendorInsightsScreen } from './screens/VendorInsightsScreen';
import { VendorAccountScreen } from './screens/VendorAccountScreen';
import { VendorScheduleScreen } from './screens/VendorScheduleScreen';

const Stack = createNativeStackNavigator();

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
  const { owner, store, stores, isLoading, state: profileState, failure, refetch } = useVendorProfile();
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
  // [MOB-038] An outage is not "you have no business". A failed profile read
  // used to arrive as null and land here as the setup wizard — offered to a
  // working restaurant while its orders were live. Absence is a verified 404
  // (or a well-formed owner with no stores); everything else says so, and
  // offers the one thing that helps: try again.
  if (profileState === 'error') {
    return (
      <Screen>
        <ErrorState
          message={
            failure === 'unauthorized' ? 'Your session ended. Sign in again to open your store.'
              : failure === 'forbidden' ? 'This account cannot open that store. Ask the owner to add you again.'
                : failure === 'malformed' ? "Swift could not read your store's details. This is our problem, not yours — try again."
                  : "Swift can't reach your store right now. Your orders are safe; try again in a moment."
          }
          onRetry={refetch}
        />
      </Screen>
    );
  }
  if (!store) return <BusinessSetup />;
  const suspensionSource = store.suspensionSource == null ? null : String(store.suspensionSource).toUpperCase();
  // [MOB-038] A blocked subscription blocks, whether or not it was mirrored
  // onto the store row. Requiring store.status === 'SUSPENDED' left a store
  // whose subscription was SUSPENDED or CHURNED taking orders it could not be
  // paid for. The suspension SOURCE still decides which reason is shown.
  const billingSuspended = billingBlocked(store) && suspensionSource !== 'MODERATION';
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
