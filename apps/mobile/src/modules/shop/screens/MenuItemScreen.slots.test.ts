import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refetchSlots: vi.fn(),
  slots: {} as Record<string, any>,
  effects: [] as Array<() => void>,
  useStateCall: 0,
  selectedSlot: null as string | null,
  setSelectedSlot: vi.fn(),
}));

vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = {
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => {
      const call = mocks.useStateCall++;
      const value = call === 3
        ? mocks.selectedSlot
        : typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [value, call === 3 ? mocks.setSelectedSlot : vi.fn()];
    },
    useRef: (value: unknown) => ({ current: value }),
    useEffect: (effect: () => void) => mocks.effects.push(effect),
  };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});
vi.mock('react-native', () => ({
  Dimensions: { get: () => ({ width: 390 }) },
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: vi.fn() }),
  useRoute: () => ({ params: { vendorId: 'vendor-1', itemId: 'service-item-1' } }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@swift/ui', () => ({
  color: {
    surface: { subtle: 'surface-subtle', base: 'surface-base' }, brand: { 50: 'brand-50', 600: 'brand-600' },
    soft: { warning: 'warning-soft' }, warning: 'warning', star: 'star', error: 'error',
  },
  elevation: { dock: {} },
  radius: { md: 8, xl: 24 },
  space: { sm: 4, md: 8, lg: 12, '2xl': 24 },
}));
vi.mock('../../../hooks/customer', () => ({
  useVendor: () => ({
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: {
      name: 'Sharp Cuts', addressLine1: '1 Main Street',
      categories: [{ items: [{
        id: 'service-item-1', name: 'Haircut', fulfillment: 'APPOINTMENT',
        basePrice: 2_000, stockQuantity: null, optionGroups: [], isAvailable: true,
      }] }],
    },
  }),
  useAddToCart: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useItemSlots: () => ({ ...mocks.slots, refetch: mocks.refetchSlots }),
}));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: () => ({ isAuthenticated: true, promptLogin: vi.fn() }),
}));
vi.mock('../../../stores/bookingStore', () => ({
  useBookingStore: (select: (state: unknown) => unknown) => select({ setAppointment: vi.fn() }),
}));
vi.mock('../../../lib/images', () => ({ itemPhoto: () => null }));
vi.mock('../../../lib/money', () => ({ money: (amount: number) => `$${amount}` }));
vi.mock('../../../kit', () => Object.fromEntries([
  'Photo', 'Chip', 'CircleChip', 'ErrorState', 'IconChip', 'LoadingBlock', 'Money',
  'PillButton', 'PopupCard', 'PopupTitle', 'QtyStepper', 'SectionHeader', 'T',
].map((name) => [name, name])));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));

import { MenuItemScreen } from './MenuItemScreen';

function collect(node: any, text: string[] = [], chips: any[] = []): { text: string[]; chips: any[] } {
  if (node == null || typeof node === 'boolean') return { text, chips };
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node));
    return { text, chips };
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, text, chips);
    return { text, chips };
  }
  if (node.type === 'Chip') chips.push(node.props);
  if (node.type === 'PillButton' && typeof node.props?.label === 'string') text.push(node.props.label);
  collect(node.props?.children, text, chips);
  return { text, chips };
}

function render() {
  return collect(MenuItemScreen());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects = [];
  mocks.useStateCall = 0;
  mocks.selectedSlot = null;
  mocks.slots = {
    data: undefined,
    isPending: false,
    isLoading: false,
    isFetching: false,
    isError: false,
  };
});

describe('service appointment time states', () => {
  it('shows a real 13:00Z instant for a 09:00 Guyana booking as 9:00 AM', () => {
    mocks.selectedSlot = '2026-09-24T13:00:00.000Z';
    mocks.slots = {
      ...mocks.slots,
      data: { slots: [mocks.selectedSlot], bookableWeekdays: [4] },
    };
    const ui = render();

    expect(ui.chips.some((chip) => chip.label === '9:00 AM')).toBe(true);
    expect(ui.text.join(' ')).toContain('Book 9:00 AM');
  });

  it('shows initial loading only while the first bounded request is pending', () => {
    mocks.slots = { ...mocks.slots, isPending: true, isLoading: true, isFetching: true };
    expect(render().text.join(' ')).toContain('Checking times…');
  });

  it('shows an honest retry state for a timeout, network error, or server failure', () => {
    mocks.slots = { ...mocks.slots, isError: true, error: new Error('timeout') };
    const ui = render();

    expect(ui.text.join(' ')).toContain('Couldn’t load available times. Check your connection and try again.');
    const retry = ui.chips.find((chip) => chip.label === 'Try again');
    expect(retry).toBeDefined();
    retry.onPress();
    expect(mocks.refetchSlots).toHaveBeenCalledOnce();
  });

  it('distinguishes a successful empty day from a request failure', () => {
    mocks.slots = { ...mocks.slots, data: { slots: [], bookableWeekdays: [1, 2, 3] } };
    const text = render().text.join(' ');
    expect(text).toContain('No times left this day — try another.');
    expect(text).not.toContain('Couldn’t load');
  });

  it('keeps known slots visible during a background freshness check', () => {
    mocks.slots = {
      ...mocks.slots,
      data: { slots: ['2026-09-24T17:00:00.000Z'], bookableWeekdays: [4] },
      isFetching: true,
    };
    const ui = render();

    expect(ui.text.join(' ')).not.toContain('Checking times…');
    expect(ui.chips.some((chip) => chip.label === '1:00 PM')).toBe(true);
  });

  it('keeps last-known slots visible after a background refresh failure and offers refresh', () => {
    mocks.slots = {
      ...mocks.slots,
      data: { slots: ['2026-09-24T17:00:00.000Z'], bookableWeekdays: [4] },
      isError: true,
      error: new Error('server unavailable'),
    };
    const ui = render();

    expect(ui.chips.some((chip) => chip.label === '1:00 PM')).toBe(true);
    expect(ui.text.join(' ')).toContain('These are the last known times.');
    const refresh = ui.chips.find((chip) => chip.label === 'Refresh');
    refresh.onPress();
    expect(mocks.refetchSlots).toHaveBeenCalledOnce();
  });

  it('disarms a selected slot when a successful freshness poll proves another customer took it', () => {
    mocks.selectedSlot = '2026-09-24T13:00:00.000Z';
    mocks.slots = {
      ...mocks.slots,
      data: { slots: ['2026-09-24T14:00:00.000Z'], bookableWeekdays: [4] },
    };

    render();
    expect(mocks.effects.length).toBeGreaterThan(0);
    mocks.effects[0]!();

    expect(mocks.setSelectedSlot).toHaveBeenCalledExactlyOnceWith(null);
  });
});
