import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fx = vi.hoisted(() => ({
  platform: { OS: 'android' }, open: vi.fn(), navigate: vi.fn(),
  orders: [] as any[], frames: [] as Array<() => void>, token: new Proxy({}, { get: () => 8 }),
}));
vi.mock('react', async (original) => {
  const actual = await original<any>();
  return { ...actual, useMemo: (fn: () => unknown) => fn() };
});
vi.mock('react-native', () => ({ Platform: fx.platform, View: 'View', ScrollView: 'ScrollView', FlatList: 'FlatList' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: fx.navigate }) }));
vi.mock('@swift/ui', () => ({ color: { brand: fx.token, text: fx.token, surface: fx.token }, space: fx.token }));
vi.mock('../hooks/customer', () => ({ useOrders: () => ({ data: fx.orders, isLoading: false, isError: false }) }));
vi.mock('../stores/authStore', () => ({ useAuthStore: () => ({ isAuthenticated: true }) }));
vi.mock('../lib/openExternal', () => ({ openExternal: fx.open }));
vi.mock('../modules/mover/surface', () => ({ withAlpha: (v: unknown) => v }));
vi.mock('../kit', () => Object.fromEntries(['Header', 'Screen', 'SettingsRow', 'T', 'TonePill', 'Card', 'EmptyState', 'ErrorState', 'LoadingBlock'].map((name) => [name, name])));
import { ContactUsScreen } from '../modules/profile/screens/ContactUsScreen';
import { ChatListScreen } from '../modules/chat/screens/ChatListScreen';
import { jobAmount } from '../modules/mover/shared';
import { afterDismiss } from '../kit/after-dismiss';
function nodes(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object' || !node.props) return [];
  return [node, ...nodes(node.props.children)];
}
beforeEach(() => {
  vi.clearAllMocks(); fx.orders = []; fx.frames = [];
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fx.frames.push(fn); return fx.frames.length; });
});
afterEach(() => vi.unstubAllGlobals());
describe('launch support truth', () => {
  it('offers the published support line and email with working actions', () => {
    const rows = nodes(ContactUsScreen()).filter((node) => node.type === 'SettingsRow');
    const phone = rows.find((node) => node.props.sub === '+592 716 3534');
    expect(phone, 'published phone is reachable').toBeDefined();
    phone.props.onPress();
    expect(fx.open).toHaveBeenCalledWith('tel:+5927163534', expect.any(String));
    rows.find((node) => node.props.sub === 'support@swiftgy.com')!.props.onPress();
    expect(fx.open).toHaveBeenCalledWith('mailto:support@swiftgy.com', expect.any(String));
  });
  it.each([undefined, {}, { totalAmount: '' }, { totalAmount: ' ' }, { totalAmount: 'broken' }, { totalAmount: NaN }, { fare: Infinity }, { fare: false }])('shows unavailable for an unknown job amount %j', (job) => {
    expect(jobAmount(job)).toBe('Amount unavailable');
  });
  it.each([{ totalAmount: 0 }, { taxiFareTotal: '0' }, { fare: 0 }])('preserves authoritative zero %j', (job) => {
    expect(jobAmount(job)).toBe('$0');
  });
  it('preserves field precedence and numeric decimal strings', () => {
    expect(jobAmount({ totalAmount: 1250, taxiFareTotal: 900 })).toBe('$1,250');
    expect(jobAmount({ taxiFareTotal: '2400' })).toBe('$2,400');
    expect(jobAmount({ totalAmount: 'bad', fare: 20 })).toBe('Amount unavailable');
  });
  it.each(['RIDER_ASSIGNED', 'READY_FOR_PICKUP', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'])('keeps rider chat reachable in %s', (status) => {
    fx.orders = [{ id: 'live-order', status, rider: { firstName: 'Rider' } }, { id: 'no-rider', status }];
    const list = nodes(ChatListScreen()).find((node) => node.type === 'FlatList');
    expect(list?.props.data.map((row: any) => row.id)).toEqual(['live-order']);
  });
  it('preserves completed history and excludes cancelled orders', () => {
    fx.orders = ['CANCELLED', 'COMPLETED', 'DELIVERED'].map((status) => ({ id: status, status, rider: {} }));
    expect(nodes(ChatListScreen()).find((node) => node.type === 'FlatList')?.props.data.map((row: any) => row.id)).toEqual(['COMPLETED', 'DELIVERED']);
  });
  it.each(['android', 'ios'])('defers navigation through both frames on %s', (platform) => {
    fx.platform.OS = platform;
    const go = vi.fn(); afterDismiss(go);
    expect(go).not.toHaveBeenCalled();
    expect(fx.frames).toHaveLength(1); fx.frames.shift()!();
    expect(go).not.toHaveBeenCalled();
    expect(fx.frames).toHaveLength(1); fx.frames.shift()!();
    expect(go).toHaveBeenCalledOnce();
  });
});
