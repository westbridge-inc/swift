/** @jsxImportSource react */
import React from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useNotifications } from '../../../hooks/customer';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { Card, EmptyState, ErrorState, Header, IconChip, LoadingBlock, PressableScale, Screen, T } from '../../../kit';
import { destinationFor, HOME_SCREEN } from '../../../services/notification-router';
import { safeNavigate } from '../../../navigation/navigationRef';
import { TeamInviteCards } from '../components/TeamInviteCards';

// Kit Notification (56): stacked rows with icon chips; unread carries a dot.
const ICON_FOR: Record<string, React.ComponentProps<typeof IconChip>['icon']> = {
  ORDER: 'shopping-bag',
  PROMO: 'tag',
  SYSTEM: 'info',
  PAYMENT: 'dollar-sign',
};

// Notifications are account-level, but SURFACES are role-level: someone who
// drives AND shops must not see operator alerts (docs expiring, taken
// offline) inside the shopping app — those belong to the driver/business
// surface. L2 identity is customer-side and stays.
const EARNER_KINDS = new Set([
  'verification_approved',
  'verification_rejected',
  'verification_expired',
  'verification_expiry_reminder',
  'verification_application_abandoned',
  'verification_forced_offline',
]);

/** Can a navigate from this screen land on `screen`? Only when this navigator,
 *  or one it sits inside, registers it right now. Untagged legacy rows still
 *  reach this list (the deny-list above covers only verification kinds), and
 *  several of them resolve to a screen only another role's stack mounts: a
 *  store's order alert opens VendorOrderDetail, a driver's check opens
 *  GuardianDriverConfirm. From the shopping app that navigate goes nowhere,
 *  silently. [TST-001]: a screen existing somewhere does not make it
 *  reachable by the person tapping. */
function canReach(navigation: NavigationProp<ParamListBase> | undefined, screen: string): boolean {
  for (let nav = navigation; nav; nav = nav.getParent()) {
    if (nav.getState()?.routeNames.includes(screen)) return true;
  }
  return false;
}

/** The route this screen is mounted as (CustomerStack). */
const INBOX_SCREEN = 'Notifications';
function opensThisInbox(dest: { screen: string; params?: Record<string, unknown> }): boolean {
  const nested = dest.params?.['screen'];
  return (typeof nested === 'string' ? nested : dest.screen) === INBOX_SCREEN;
}

export function NotificationsScreen() {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const notifications = useNotifications<any>();
  // [UI-SWEEP U33] Pull to refresh like the sibling lists; the spinner follows the pull only (hooks/usePullToRefresh).
  const pull = usePullToRefresh(() => notifications.refetch());
  const all: any[] = Array.isArray(notifications.data)
    ? notifications.data
    : (notifications.data?.notifications ?? []);
  // Server-tagged audience wins; the kind deny-list covers legacy rows.
  const rows = all.filter((n) => {
    const audience = n?.data?.audience;
    if (audience) return audience === 'customer';
    return !EARNER_KINDS.has(n?.data?.kind);
  });

  return (
    <Screen>
      <Header title="Notification" />
      {/* [Row 55] Store team invites are answered here, above the inbox. */}
      <TeamInviteCards />
      {notifications.isLoading ? (
        <LoadingBlock />
      ) : notifications.isError ? (
        <ErrorState onRetry={() => notifications.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon="bell" title="Nothing yet" body="Order updates and promos will land here." />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(n, i) => n.id ?? String(i)}
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={() => { void pull.onRefresh(); }} tintColor={color.brand[500]} />}
          contentContainerStyle={{ padding: space['2xl'], gap: space.md }}
          renderItem={({ item: n }) => {
            const card = (
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md }}>
                <IconChip icon={ICON_FOR[n.type] ?? 'bell'} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="body" weight={n.isRead ? 'regular' : 'semibold'} numberOfLines={1}>
                    {n.title ?? 'Update'}
                  </T>
                  <T variant="caption" tone="muted" numberOfLines={2}>
                    {n.body ?? n.message ?? ''}
                  </T>
                  <T variant="caption" tone="faint">
                    {n.createdAt ? new Date(n.createdAt).toLocaleString() : ''}
                  </T>
                </View>
                {!n.isRead ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color.brand[500] }} /> : null}
              </Card>
            );
            // [E28] A row tap IS a push tap: the same destinationFor table the
            // tap-router uses, so the two surfaces cannot drift into two
            // mappings. A row is a button only when it has somewhere to go
            // that this screen can reach. A row with no destination, or one
            // that lives in another role's stack, stays a plain card, because
            // a button that goes nowhere is the defect this fixes.
            // [PUSH-ROUTING] A push that opens HOME on purpose (the notice is
            // the whole message) moves nothing from inside the app, so its
            // row is a plain card too.
            const dest = destinationFor(n?.data);
            if (!dest || dest.screen === HOME_SCREEN || !canReach(navigation, dest.screen)) return card;
            // [UI-SWEEP U31] A push that opens THIS inbox (a store team invite:
            // its Accept / Decline card is right here) is a plain card too; as a
            // button it stacked a second, identical inbox.
            if (opensThisInbox(dest)) return card;
            return (
              <PressableScale accessibilityRole="button" onPress={() => safeNavigate(dest.screen, dest.params)}>
                {card}
              </PressableScale>
            );
          }}
        />
      )}
    </Screen>
  );
}
