import { beforeEach, describe, expect, it, vi } from 'vitest';

// [E28] Inbox rows were bare cards: the push tap-router existed, but the
// notification list never called it, so a row tap did nothing. This suite
// drives the REAL NotificationsScreen (component called as a function — no
// React renderer, as in PersonalDataScreen.test.ts) and the REAL
// destinationFor, with only the native modules, the data hook and
// safeNavigate stubbed. A row tap must equal a push tap: one router, never a
// second mapping.

const mocks = vi.hoisted(() => ({
  safeNavigate: vi.fn(() => true),
  notifications: { data: undefined as unknown, isLoading: false },
}));

vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  getLastNotificationResponseAsync: () => Promise.resolve(null),
}));
// The same mock the screen and the production router both resolve, so the
// mapping under test is the production one and every navigate is observable.
vi.mock('../../../navigation/navigationRef', () => ({
  navigationRef: { isReady: () => true },
  safeNavigate: mocks.safeNavigate,
}));
vi.mock('../../../hooks/customer', () => ({
  useNotifications: () => mocks.notifications,
}));
vi.mock('react-native', () => ({ FlatList: 'FlatList', View: 'View' }));
vi.mock('@swift/ui', () => ({ color: { brand: {} }, space: {} }));
vi.mock('../../../kit', () =>
  Object.fromEntries(
    ['Card', 'EmptyState', 'ErrorState', 'Header', 'IconChip', 'LoadingBlock', 'PressableScale', 'Screen', 'T'].map(
      (name) => [name, name],
    ),
  ),
);

import { destinationFor } from '../../../services/notification-router';
import { NotificationsScreen } from './NotificationsScreen';

interface Element {
  type: unknown;
  props: Record<string, unknown>;
}

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/** Every element in a returned tree — children and element-valued props. */
function elements(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
  } else if (isElement(node)) {
    found.push(node);
    for (const value of Object.values(node.props ?? {})) elements(value, found);
  }
  return found;
}

/** Render the screen with the given rows and return the first row's pressable. */
function pressableForFirstRow(rows: unknown[]): { pressable: Element; row: any } {
  mocks.notifications = { data: { notifications: rows }, isLoading: false };
  const screen = NotificationsScreen();
  const flatList = elements(screen).find((el) => el.type === 'FlatList');
  if (!flatList) throw new Error('NotificationsScreen rendered no list');
  const renderItem = flatList.props['renderItem'] as (info: { item: unknown }) => unknown;
  const rendered = renderItem({ item: rows[0] });
  const pressables = elements(rendered).filter((el) => el.type === 'PressableScale');
  expect(pressables, 'the notification row is tappable').toHaveLength(1);
  return { pressable: pressables[0]!, row: rows[0] };
}

/** Invoke a row's press handler the way React Native's Pressable does. */
function press(el: Element) {
  const onPress = el.props['onPress'] as (() => void) | undefined;
  expect(onPress, 'the row has a press handler').toBeTypeOf('function');
  onPress!();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notifications = { data: { notifications: [] }, isLoading: false };
  mocks.safeNavigate.mockReturnValue(true);
});

describe('notification rows navigate through the push tap-router', () => {
  it('an ORDER_UPDATE row lands exactly where the push router sends it', () => {
    const row = {
      id: 'n1',
      type: 'ORDER_UPDATE',
      title: 'Ready for pickup',
      body: 'Your order is ready',
      isRead: false,
      data: { kind: 'prep_ready', orderId: 'o1' },
    };
    const { pressable } = pressableForFirstRow([row]);

    press(pressable);

    // The row tap equals the push tap: same table, same destination.
    expect(destinationFor(row.data)).toEqual({ screen: 'Delivery', params: { orderId: 'o1' } });
    expect(mocks.safeNavigate).toHaveBeenCalledExactlyOnceWith('Delivery', { orderId: 'o1' });
  });

  it('a customer reschedule row never navigates to vendor-only Schedule', () => {
    const row = {
      id: 'n2',
      type: 'ORDER_UPDATE',
      title: 'Your appointment moved',
      body: 'Your store moved the appointment',
      isRead: false,
      data: { kind: 'booking_rescheduled', bookingId: 'b1', audience: 'customer' },
    };
    const { pressable } = pressableForFirstRow([row]);

    press(pressable);

    // CustomerStack never mounts Schedule, so this tap was a silent dead
    // navigate before the fix. There is no customer appointments screen: the
    // router resolves null and the row opens nothing, never a dead Schedule.
    expect(destinationFor(row.data)).toBeNull();
    expect(mocks.safeNavigate).not.toHaveBeenCalledWith('Schedule', expect.anything());
    expect(mocks.safeNavigate).not.toHaveBeenCalled();
  });

  it('an unknown kind is inert, exactly like a push with no destination', () => {
    const row = {
      id: 'n3',
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Something',
      body: 'No screen for this',
      isRead: false,
      data: { kind: 'billing_topup' },
    };
    const { pressable } = pressableForFirstRow([row]);

    press(pressable);

    expect(destinationFor(row.data)).toBeNull();
    expect(mocks.safeNavigate).not.toHaveBeenCalled();
  });
});
