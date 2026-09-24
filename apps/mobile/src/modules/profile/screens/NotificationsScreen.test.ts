import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [E28] Inbox rows were bare cards: the push tap-router existed, but the
// notification list never called it, so tapping a row did nothing. This suite
// drives the REAL NotificationsScreen (the component is called as a function,
// with no React renderer, as in PersonalDataScreen.test.ts) and the REAL
// destinationFor. Only the native modules, the data hook, safeNavigate and the
// navigator the screen sits in are stubbed. That navigator carries the route
// names CustomerStack.tsx really registers, read from the file below.
//
// The contract: a row tap equals a push tap (one table, never a second
// mapping), and a row is a button only when it has somewhere to go that this
// screen can reach. A button that goes nowhere is the defect being fixed.

const mocks = vi.hoisted(() => ({
  safeNavigate: vi.fn((_screen: string, _params?: Record<string, unknown>) => true),
  notifications: { data: undefined as unknown, isLoading: false },
  stackRouteNames: [] as string[],
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
// The navigator this screen sits in, as React Navigation reports it:
// CustomerStack, inside the root stack whose only route is `Main`.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    getState: () => ({ routeNames: mocks.stackRouteNames }),
    getParent: () => ({ getState: () => ({ routeNames: ['Main'] }), getParent: () => undefined }),
  }),
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

/** Every screen CustomerStack registers. The inbox is mounted there. */
const CUSTOMER_STACK = [
  ...readFileSync(join(process.cwd(), 'src', 'navigation', 'CustomerStack.tsx'), 'utf8').matchAll(
    /\.Screen[^>]*?name="([A-Za-z0-9_]+)"/g,
  ),
].map((m) => m[1]!);

interface Element {
  type: unknown;
  props: Record<string, unknown>;
}

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/** Every element in a returned tree: children and element-valued props. */
function elements(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
  } else if (isElement(node)) {
    found.push(node);
    for (const value of Object.values(node.props ?? {})) elements(value, found);
  }
  return found;
}

type Row = { id: string; type: string; title: string; body?: string; isRead: boolean; data: unknown };

/** Render the inbox over `rows` and return its list. GET /customer/notifications
 *  answers { data: [rows], meta } and the hook unwraps it to the plain array,
 *  so the array is the shape the screen really receives. */
function renderList(rows: Row[]): Element {
  mocks.notifications = { data: rows, isLoading: false };
  const list = elements(NotificationsScreen()).find((el) => el.type === 'FlatList');
  if (!list) throw new Error('NotificationsScreen rendered no list');
  return list;
}

/** Render one row the inbox lists. Asserts it is listed, so no case is vacuous. */
function renderRow(item: Row): unknown {
  const list = renderList([item]);
  expect(list.props['data'], 'the row is listed in the inbox').toEqual([item]);
  const renderItem = list.props['renderItem'] as (info: { item: Row }) => unknown;
  return renderItem({ item });
}

const buttonsIn = (tree: unknown) => elements(tree).filter((el) => el.type === 'PressableScale');

/** The row must be exactly one button; press it the way a Pressable does. */
function pressTheRow(tree: unknown): Element {
  const buttons = buttonsIn(tree);
  expect(buttons, 'the row is tappable').toHaveLength(1);
  const onPress = buttons[0]!.props['onPress'];
  expect(onPress, 'the row has a press handler').toBeTypeOf('function');
  (onPress as () => void)();
  return buttons[0]!;
}

const row = (data: unknown, id = 'n1'): Row => ({
  id,
  type: 'ORDER_UPDATE',
  title: 'Update',
  body: 'Something changed',
  isRead: false,
  data,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notifications = { data: [], isLoading: false };
  mocks.stackRouteNames = CUSTOMER_STACK;
});

describe('the stack this suite models', () => {
  it('is the one that mounts the inbox, and it has no store or driver screens', () => {
    expect(CUSTOMER_STACK).toContain('Notifications');
    expect(CUSTOMER_STACK).toContain('Delivery');
    expect(CUSTOMER_STACK).not.toContain('Schedule');
    expect(CUSTOMER_STACK).not.toContain('VendorOrderDetail');
  });
});

describe('an inbox row opens exactly where its push opens [E28]', () => {
  it.each([
    ['an order update', { kind: 'prep_ready', orderId: 'o1' }, 'Delivery'],
    ['a ride update', { kind: 'ride_queue_matched', orderId: 'o2', audience: 'customer' }, 'Taxi'],
    ['a service-job update', { kind: 'booking_confirmed', jobId: 'j1' }, 'ServiceJobs'],
  ])('%s row is a button that navigates through the push table', (_label, data, screen) => {
    const button = pressTheRow(renderRow(row(data)));
    expect(button.props['accessibilityRole']).toBe('button');

    const dest = destinationFor(data);
    expect(dest?.screen).toBe(screen);
    expect(mocks.safeNavigate).toHaveBeenCalledExactlyOnceWith(dest!.screen, dest!.params);
  });

  it('an order row carries the order it is about', () => {
    pressTheRow(renderRow(row({ kind: 'prep_ready', orderId: 'o1' })));
    expect(mocks.safeNavigate).toHaveBeenCalledExactlyOnceWith('Delivery', { orderId: 'o1' });
  });
});

describe('a row with nowhere to go is not a button [E28]', () => {
  it('the customer copy of a moved appointment never aims at the store-only Schedule', () => {
    const data = { kind: 'booking_rescheduled', bookingId: 'b1', audience: 'customer' };
    expect(destinationFor(data)).toBeNull();
    expect(buttonsIn(renderRow(row(data)))).toEqual([]);
    expect(mocks.safeNavigate).not.toHaveBeenCalled();
  });

  it('a store alert that reached the shopping inbox is not a button that opens nothing', () => {
    // vendor_order_alert is sent without an audience, so the inbox filter
    // lists it for someone who both runs a store and shops. It resolves to the
    // store's order desk, a screen CustomerStack does not mount.
    const data = { kind: 'vendor_order_alert', orderId: 'o9' };
    expect(destinationFor(data)).toEqual({ screen: 'VendorOrderDetail', params: { orderId: 'o9' } });
    expect(buttonsIn(renderRow(row(data)))).toEqual([]);
    expect(mocks.safeNavigate).not.toHaveBeenCalled();
  });

  it('a kind with no screen, or a row with no payload, is a plain card', () => {
    for (const data of [{ kind: 'verification_l2', audience: 'customer' }, null]) {
      expect(destinationFor(data as Record<string, unknown> | null)).toBeNull();
      expect(buttonsIn(renderRow(row(data)))).toEqual([]);
    }
    expect(mocks.safeNavigate).not.toHaveBeenCalled();
  });
});

describe('the store copy of a moved appointment stays out of the shopping inbox', () => {
  it('lists only the customer-tagged copy', () => {
    // The API now tags the store owner's copy audience:'business' [E28]. The
    // inbox already lists only customer-audience rows, so that copy leaves
    // the shopping app; the store gets it as a push that opens Schedule.
    const storeCopy = row({ kind: 'booking_rescheduled', bookingId: 'b1', audience: 'business' }, 'store');
    const customerCopy = row({ kind: 'booking_rescheduled', bookingId: 'b1', audience: 'customer' }, 'mine');
    expect(renderList([storeCopy, customerCopy]).props['data']).toEqual([customerCopy]);
  });
});
