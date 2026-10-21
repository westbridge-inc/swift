import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Execute the real screens and safety hooks with synthetic API responses.
// Only the native rendering boundary and the query scheduler are replaced.
const host = vi.hoisted(() => ({
  index: 0, slots: [] as Array<{ value: unknown }>,
  status: 'ACTIVE', tasks: [] as Promise<unknown>[],
  getSos: vi.fn(), flagged: null as string | null, monitoringValue: false,
  sos: vi.fn(), monitoringRead: vi.fn(), monitoringWrite: vi.fn(), markSafe: vi.fn(),
  ownedRows: [] as Array<Record<string, unknown>>,
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const slot = (initial: unknown) => host.slots[host.index++] ?? (host.slots[host.index - 1] = { value: initial });
  const hooks = {
    useState: (initial: unknown) => { const s = slot(initial); return [s.value, (next: unknown) => { s.value = typeof next === 'function' ? next(s.value) : next; }]; },
    useRef: (current: unknown) => slot({ current }).value,
    useEffect: () => undefined,
  };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useInfiniteQuery: () => ({ data: { pages: [{ rows: host.ownedRows, nextCursor: null }] }, isPending: false, isError: false, isFetching: false, hasNextPage: false, refetch: vi.fn() }),
  useQuery: (options: { queryKey: string[] }) => ({ data: options.queryKey.includes('owned-alert') ? { id: 'synthetic-alert', actorUserId: 'synthetic-owner', status: host.status, userSafeFlaggedAt: host.flagged } : options.queryKey.includes('monitoring') ? host.monitoringValue : undefined, isLoading: false, refetch: async () => ({ data: options.queryKey.includes('monitoring') ? host.monitoringValue : false }) }),
  useMutation: (options: { mutationFn: (arg: unknown) => Promise<unknown>; onSuccess?: () => void; onSettled?: () => void }) => ({
    isPending: false, isError: false,
    mutate: (arg: unknown, callbacks?: { onSuccess?: (data: unknown) => void; onError?: (err: unknown) => void; onSettled?: () => void }) => {
      const task = Promise.resolve().then(() => options.mutationFn(arg)).then((data) => {
        options.onSuccess?.(); callbacks?.onSuccess?.(data);
      }, callbacks?.onError).finally(() => { options.onSettled?.(); callbacks?.onSettled?.(); });
      host.tasks.push(task);
    },
  }),
}));
vi.mock('../../services/api', () => ({
  API_URL: 'https://synthetic.invalid', customerApi: {},
  safetyApi: { sos: host.sos, monitoringPreference: host.monitoringRead, setMonitoringPreference: host.monitoringWrite, markSafeSos: host.markSafe, getSos: host.getSos },
}));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../lib/sosKey', () => ({ createSosKeyStore: () => ({ keyFor: () => 'synthetic-sos-request' }) }));
vi.mock('../../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../../lib/haptics', () => ({ haptic: vi.fn() }));
vi.mock('../../lib/payLink', () => ({ openPayLink: vi.fn() }));
vi.mock('../../lib/appQueryPolicy', () => ({ retryRead: () => true }));
vi.mock('../../stores/authStore', () => {
  const state = { isAuthenticated: true, user: { id: 'synthetic-owner' }, sessionGeneration: 1 };
  return { useAuthStore: (select?: (s: typeof state) => unknown) => (select ? select(state) : state), requireAuthSessionForPrincipal: (owner: unknown) => owner };
});
vi.mock('../../hooks/customer', () => ({ useProfile: () => ({ data: {}, isLoading: false }), useMyRating: () => ({ data: null }), useLiveOrders: () => ({ data: { total: 0 } }) }));
vi.mock('../../services/emergencyPolicy', () => ({ useEmergencyPolicy: () => ({ country: 'GY', dial: { kind: 'manual' } }), emergencyDialFor: () => ({ kind: 'manual' }), emergencyDialCopy: () => 'Call your local emergency number.' }));
vi.mock('../../lib/emergencyPolicy', () => ({ locationAccuracyBand: () => 'none', recordSosLocation: vi.fn(), recordSosTransition: vi.fn(), telUrl: (n: string) => `tel:${n}` }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', StyleSheet: { hairlineWidth: 1 }, AccessibilityInfo: { announceForAccessibility: vi.fn() } }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
// Profile's import graph reaches the app's encrypted store (native); nothing here persists.
vi.mock('../../lib/storage', () => ({ zustandStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 20, bottom: 0 }) }));
vi.mock('react-native-reanimated', () => {
  const animation = { duration: () => animation, reduceMotion: () => animation };
  return { default: { View: 'AnimatedView' }, FadeInDown: animation, ReduceMotion: { System: 'System' } };
});
vi.mock('@swift/ui', () => ({ color: { text: {}, border: {}, surface: {}, brand: {} }, radius: {}, space: {}, withAlpha: () => 'synthetic-color' }));
vi.mock('../../kit/controls', () => ({ BrandSwitch: 'BrandSwitch' }));
vi.mock('../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: 'RoleSwitcherSheet' }));
vi.mock('../../kit', () => ({
  ...Object.fromEntries(['DecorativeIcon', 'EmptyState', 'ErrorState', 'IconChip', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'SettingsRow', 'T', 'TrustHalo'].map((name) => [name, name])),
  useLogoutConfirm: () => ({ requestLogout: vi.fn(), logoutDialog: null }),
}));

import { MonitoringControl } from './MonitoringControl';
import { OwnedSosActions } from './OwnedSosActions';
import { SosCeremony } from './SosCeremony';
import { ProfileScreen } from '../profile/screens/ProfileScreen';
import { OwnedSafetyPanel } from './OwnedSafetyPanel';

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  // Execute local composition such as RowGroup; native kit hosts stay strings.
  if (typeof el.type === 'function') return elements((el.type as (props: unknown) => unknown)(el.props));
  return [el, ...Object.values(el.props).flatMap(elements)];
}
function renderSos() {
  host.index = 0;
  return elements(SosCeremony({ visible: true, onClose: vi.fn(), context: { orderId: 'synthetic-job' }, getCoords: () => undefined, recordNoun: 'job' }));
}
beforeEach(() => {
  vi.clearAllMocks(); host.index = 0; host.slots = []; host.tasks = []; host.flagged = null; host.monitoringValue = false;
  host.status = 'ACTIVE'; host.ownedRows = [];
  host.getSos.mockImplementation(async () => ({ data: { data: { id: 'synthetic-alert', actorUserId: 'synthetic-owner', status: host.status, userSafeFlaggedAt: host.flagged } } }));
  host.monitoringWrite.mockResolvedValue({ data: { data: {} } });
  host.markSafe.mockResolvedValue({ data: { data: {} } });
  host.sos.mockImplementation(async () => ({ data: { data: { id: 'synthetic-alert', status: host.status, graceEndsAt: null } } }));
});

describe('reachable safety controls on real mobile components', () => {
  it('offers enhanced monitoring from the signed-in profile', () => {
    const rows = elements(ProfileScreen());
    expect(rows.some((row) => /extra safety|enhanced monitoring/i.test(String(row.props['label'] ?? row.props['accessibilityLabel'] ?? ''))), 'signed-in profile has a reachable monitoring control').toBe(true);
  });
  it.each(['ACTIVE', 'ACKNOWLEDGED'])('%s SOS offers the owner a mark-safe action', async (status) => {
    host.status = status;
    const start = renderSos().find((el) => el.type === 'PillButton' && el.props['label'] === 'Alert Swift now');
    expect(start, 'initial real ceremony exposes the raise control').toBeDefined();
    (start!.props['onPress'] as () => void)();
    await Promise.all(host.tasks);
    expect(host.sos).toHaveBeenCalledOnce();
    expect(host.sos.mock.calls[0]![0]).toMatchObject({ orderId: 'synthetic-job' });
    const active = renderSos();
    expect(active.some((el) => el.type === 'PopupTitle'), 'server-raised alert rendered').toBe(true);
    expect(active.some((el) => el.type === 'PillButton' && /safe now/i.test(String(el.props['label']))), 'live owned alert has mark-safe control').toBe(true);
  });
});

describe('[73] the signed-in safety control floats only over a live alert', () => {
  it('a calm account sees nothing over the app; a live alert gets one control', () => {
    host.index = 0;
    expect(elements(OwnedSafetyPanel())).toEqual([]);
    host.ownedRows = [{ id: 'synthetic-alert', actorUserId: 'synthetic-owner', status: 'ACTIVE', userSafeFlaggedAt: null }];
    host.index = 0;
    const labels = elements(OwnedSafetyPanel()).filter((el) => el.type === 'PillButton').map((el) => el.props['label']);
    expect(labels).toContain('My safety alert');
  });
  it('[#1955 S4-3] the control sits below the safe area and the header, centred, never over a header button', () => {
    host.ownedRows = [{ id: 'synthetic-alert', actorUserId: 'synthetic-owner', status: 'ACTIVE', userSafeFlaggedAt: null }];
    host.index = 0;
    const holder = elements(OwnedSafetyPanel()).find((el) => el.type === 'View' && (el.props['style'] as { position?: string } | undefined)?.position === 'absolute')!;
    expect(holder.props['style']).toMatchObject({ top: 20 + 56, left: 0, right: 0, alignItems: 'center' });
    expect(holder.props['pointerEvents']).toBe('box-none');
  });
  it('[#1955 S4-4] an alert not sent yet is named plainly, with one plain action', () => {
    host.ownedRows = [{ id: 'synthetic-alert', actorUserId: 'synthetic-owner', status: 'TRIGGER_PENDING', userSafeFlaggedAt: null }];
    host.index = 0;
    const rows = elements(OwnedSafetyPanel());
    expect(rows.some((el) => Array.isArray(el.props['children']) && (el.props['children'] as unknown[]).join('') === 'Your alert: not sent yet')).toBe(true);
    expect(rows.some((el) => el.type === 'PillButton' && el.props['label'] === 'Cancel or send now')).toBe(true);
    expect(rows.some((el) => /grace/i.test(String(el.props['label'] ?? '')))).toBe(false);
  });
});

function renderControl(component: () => ReactElement) { host.index = 0; return elements(component()); }
describe('real safety control result presentation', () => {
  // [#1955 REVIEW-F S3-1] For a SAFETY opt-in, "I turned it on" must mean it is on: the flip IS the save.
  const toggleOf = (rows: ReactElement<Record<string, unknown>>[]) => rows.find((el) => el.type === 'BrandSwitch')!;
  const flip = (rows: ReactElement<Record<string, unknown>>[], to: boolean) => (toggleOf(rows).props['onChange'] as (value: boolean) => void)(to);
  const says = (rows: ReactElement<Record<string, unknown>>[], text: string) => rows.some((el) => typeof el.props['children'] === 'string' && el.props['children'].includes(text));
  it('a flip saves at once and the switch then shows only what Swift read back; there is no separate Save', async () => {
    host.monitoringWrite.mockImplementation(async (value: boolean) => { host.monitoringValue = value; return { data: { data: {} } }; });
    const first = renderControl(MonitoringControl);
    expect(first.some((el) => el.type === 'PillButton' && /save/i.test(String(el.props['label'])))).toBe(false);
    flip(first, true);
    expect(host.monitoringWrite).toHaveBeenCalledOnce();
    expect(host.monitoringWrite.mock.calls[0]![0]).toBe(true);
    const saving = renderControl(MonitoringControl);
    expect(toggleOf(saving).props['value']).toBe(true);
    expect(toggleOf(saving).props['disabled'], 'no second flip while the write and its read-back run').toBe(true);
    await Promise.all(host.tasks);
    const saved = renderControl(MonitoringControl);
    expect(toggleOf(saved).props['value']).toBe(true);
    expect(toggleOf(saved).props['disabled']).toBe(false);
    expect(says(saved, 'Saved and checked with Swift')).toBe(true);
  });
  it('a failed save puts the switch back to the saved value and says the change could not be confirmed', async () => {
    host.monitoringWrite.mockRejectedValue(new Error('offline'));
    flip(renderControl(MonitoringControl), true);
    await Promise.all(host.tasks);
    const failed = renderControl(MonitoringControl);
    expect(toggleOf(failed).props['value']).toBe(false);
    expect(says(failed, 'Your change could not be confirmed. Try again.')).toBe(true);
    expect(says(failed, 'Saved and checked with Swift')).toBe(false);
    expect(says(failed, 'draft')).toBe(false);
  });
  it('two flips before a re-render send one write', async () => {
    const rows = renderControl(MonitoringControl);
    flip(rows, true); flip(rows, true);
    await Promise.all(host.tasks);
    expect(host.monitoringWrite).toHaveBeenCalledOnce();
  });
  it('a lost mark-safe response shows unknown result and a refresh action', async () => {
    host.markSafe.mockRejectedValue(new Error('lost response'));
    const first = renderControl(() => OwnedSosActions({ id: 'synthetic-alert' }));
    (first.find((el) => el.type === 'PillButton' && el.props['label'] === "I'm safe now")!.props['onPress'] as () => void)();
    await Promise.all(host.tasks);
    const failed = renderControl(() => OwnedSosActions({ id: 'synthetic-alert' }));
    expect(failed.some((el) => typeof el.props['children'] === 'string' && el.props['children'].includes('could not confirm the result'))).toBe(true);
    expect(failed.some((el) => el.props['label'] === 'Refresh my alert')).toBe(true);
    expect(failed.some((el) => typeof el.props['children'] === 'string' && el.props['children'].startsWith('Swift recorded'))).toBe(false);
  });
  it('a valid server flag describes the saved acknowledgement without claiming closure', () => {
    host.flagged = '2026-09-30T12:00:00.000Z';
    const rows = renderControl(() => OwnedSosActions({ id: 'synthetic-alert' }));
    expect(rows.some((el) => el.props['children'] === 'Swift recorded that you marked yourself safe. The safety team must still verify and close the case.')).toBe(true);
    expect(rows.some((el) => el.props['label'] === "I'm safe now")).toBe(false);
  });
  it.each(['RESOLVED', 'CANCELLED'])('[#1955 S4-4] a %s alert says so plainly and offers no safe-flag write', (status) => {
    host.status = status; host.flagged = '2026-09-30T12:00:00.000Z';
    const rows = renderControl(() => OwnedSosActions({ id: 'synthetic-alert' }));
    expect(rows.some((el) => el.props['children'] === (status === 'RESOLVED' ? 'Resolved by the safety team.' : 'Cancelled.'))).toBe(true);
    expect(rows.some((el) => /server alert status/i.test(JSON.stringify(el.props['children'] ?? '')))).toBe(false);
    expect(rows.some((el) => el.type === 'PillButton' && /safe/i.test(String(el.props['label'])))).toBe(false);
  });
  it('duplicate mark-safe taps before rerender issue only one write', async () => {
    const rows = renderControl(() => OwnedSosActions({ id: 'synthetic-alert' }));
    const press = rows.find((el) => el.props['label'] === "I'm safe now")!.props['onPress'] as () => void;
    press(); press(); await Promise.all(host.tasks);
    expect(host.markSafe).toHaveBeenCalledOnce();
  });
});
