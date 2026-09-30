import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [Q8] The store map, driven through the real component. Owner report: "they
// can't just use the location they're registering from for the store, come on
// now." The picker is where the pin is now decided, so its own logic is pinned
// here: where it opens, when "Confirm store location" is allowed, and that a
// confirmation is the spot under the pin with that spot's own address line —
// never the phone's position and never an earlier spot's name.
//
// Same render runtime as VendorStack.entry.test.ts: the component is called as
// a function, its hooks run on a small per-instance runtime, and a re-render
// shows the result. The native map, the phone's geocoder and leaf visuals are
// stand-ins; lib/storePin is the real module.
// ---------------------------------------------------------------------------

type Cleanup = void | (() => void);

interface HookSlot {
  ready?: boolean;
  value?: unknown;
  deps?: readonly unknown[] | undefined;
  cleanup?: Cleanup;
  setter?: (update: unknown) => void;
}

interface Instance {
  slots: HookSlot[];
  cursor: number;
  effects: Array<() => void>;
  dirty: boolean;
}

interface View {
  readonly output: unknown;
  render: () => unknown;
  unmount: () => void;
}

const fx = vi.hoisted(() => {
  let active: Instance | null = null;
  const views = new Set<View>();

  const slot = (): [HookSlot, Instance] => {
    if (!active) throw new Error('A hook ran outside a harness render.');
    const index = active.cursor;
    active.cursor += 1;
    const existing = active.slots[index];
    if (existing) return [existing, active];
    const created: HookSlot = {};
    active.slots[index] = created;
    return [created, active];
  };
  const changed = (previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) =>
    !previous || !next || previous.length !== next.length || previous.some((value, i) => !Object.is(value, next[i]));

  const hooks = {
    useState(initial: unknown) {
      const [s, instance] = slot();
      if (!s.ready) {
        s.value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        s.setter = (update) => {
          const next = typeof update === 'function' ? (update as (previous: unknown) => unknown)(s.value) : update;
          if (Object.is(next, s.value)) return;
          s.value = next;
          instance.dirty = true;
        };
        s.ready = true;
      }
      return [s.value, s.setter];
    },
    useMemo(factory: () => unknown, deps?: readonly unknown[]) {
      const [s] = slot();
      if (!s.ready || deps === undefined || changed(s.deps, deps)) {
        s.value = factory();
        s.deps = deps;
        s.ready = true;
      }
      return s.value;
    },
    useCallback(callback: unknown, deps?: readonly unknown[]) {
      return hooks.useMemo(() => callback, deps);
    },
    useRef(initial: unknown) {
      const [s] = slot();
      if (!s.ready) {
        s.value = { current: initial };
        s.ready = true;
      }
      return s.value;
    },
    useEffect(effect: () => Cleanup, deps?: readonly unknown[]) {
      const [s, instance] = slot();
      if (s.ready && deps !== undefined && !changed(s.deps, deps)) return;
      s.ready = true;
      s.deps = deps;
      instance.effects.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup();
        s.cleanup = effect();
      });
    },
  };

  /** Mount a component: render, run its effects, and re-render until state settles. */
  function mount<P>(component: (props: P) => unknown, props: P): View {
    const instance: Instance = { slots: [], cursor: 0, effects: [], dirty: false };
    let output: unknown = null;
    let mounted = true;
    const render = () => {
      if (!mounted) throw new Error('A view was rendered after it unmounted.');
      for (let pass = 0; pass < 20; pass += 1) {
        instance.cursor = 0;
        instance.effects = [];
        instance.dirty = false;
        const outer = active;
        active = instance;
        try {
          output = component(props);
        } finally {
          active = outer;
        }
        for (const run of instance.effects) run();
        if (!instance.dirty) return output;
      }
      throw new Error('A view never settled.');
    };
    const view: View = {
      get output() {
        return output;
      },
      render,
      unmount() {
        if (!mounted) return;
        mounted = false;
        views.delete(view);
        for (const s of instance.slots) if (typeof s.cleanup === 'function') s.cleanup();
      },
    };
    views.add(view);
    render();
    return view;
  }

  // @swift/ui tokens: any path is a value, and arithmetic on one is harmless.
  const token: unknown = new Proxy({}, {
    get: (_target, key) => (key === Symbol.toPrimitive ? (hint: string) => (hint === 'number' ? 0 : '') : token),
  });

  return {
    hooks,
    mount,
    unmountAll: () => {
      for (const view of [...views]) view.unmount();
    },
    token,
    geocode: vi.fn(),
    reverse: vi.fn(),
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { default?: Record<string, unknown> }>();
  const hooks = { ...fx.hooks, useLayoutEffect: fx.hooks.useEffect };
  return { ...actual, ...hooks, default: { ...(actual.default ?? actual), ...hooks } };
});
vi.mock('react-native', () => ({ Modal: 'Modal', View: 'View', useColorScheme: () => 'light' }));
vi.mock('react-native-maps', () => ({ default: 'MapView', PROVIDER_DEFAULT: 'default' }));
vi.mock('expo-location', () => ({ geocodeAsync: fx.geocode, reverseGeocodeAsync: fx.reverse }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token, motion: { duration: { gentle: 320 } } }));
vi.mock('../kit', () => ({ CircleChip: 'CircleChip', LoadingBlock: 'LoadingBlock', PillButton: 'PillButton', PinGlyph: 'PinGlyph', T: 'T' }));
vi.mock('../kit/map-style', () => ({ rideMapProps: () => ({}) }));

import { StoreLocationPicker } from './StoreLocationPicker';

interface Element {
  type: unknown;
  key: string | null;
  props: any;
}

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

function elements(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
  } else if (isElement(node)) {
    found.push(node);
    for (const value of Object.values(node.props ?? {})) elements(value, found);
  }
  return found;
}

const ofType = (node: unknown, type: unknown) => elements(node).filter((el) => el.type === type);
const named = (node: unknown, name: string) =>
  elements(node).filter((el) => typeof el.type === 'function' && el.type.name === name);

function only(node: unknown, type: unknown): Element {
  const found = ofType(node, type);
  expect(found, `exactly one ${String(type)}`).toHaveLength(1);
  return found[0]!;
}

/** Every string a T renders, in order. */
const texts = (view: View) => ofType(view.output, 'T').map((el) => [el.props.children].flat().join(''));

/** Let resolved lookups run their continuations. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const GEORGETOWN = { latitude: 6.8013, longitude: -58.1551 };
const typedAddressPoint = { latitude: 6.8131, longitude: -58.1587 };
const phone = { latitude: 6.7712, longitude: -58.1874 };
const entrance = { latitude: 6.8139, longitude: -58.1592 };

type Props = Parameters<typeof StoreLocationPicker>[0];

/** Open the picker and return its mounted body once its start is decided. */
async function open(overrides: Partial<Props> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const props: Props = {
    visible: true,
    current: null,
    address: { line: '12 Regent Street', city: 'Georgetown' },
    device: null,
    onConfirm,
    onClose,
    ...overrides,
  };
  const picker = fx.mount(StoreLocationPicker, props);
  const bodies = named(picker.output, 'PickerBody');
  expect(bodies, 'an open picker mounts its body').toHaveLength(1);
  const body = fx.mount(bodies[0]!.type as (p: unknown) => unknown, bodies[0]!.props);
  await flush();
  body.render();
  return { body, onConfirm: props.onConfirm as ReturnType<typeof vi.fn>, onClose: props.onClose as ReturnType<typeof vi.fn> };
}

/** The owner lets go of the map with the pin over `point`. */
async function settleAt(body: View, point: { latitude: number; longitude: number }) {
  only(body.output, 'MapView').props.onRegionChangeComplete({ ...point, latitudeDelta: 0.004, longitudeDelta: 0.004 });
  body.render();
}

/** The address lookup for the spot under the pin runs once the map rests. */
async function nameSpot(body: View) {
  await vi.advanceTimersByTimeAsync(350);
  await flush();
  body.render();
}

const confirmButton = (body: View) => only(body.output, 'PillButton');

beforeEach(() => {
  vi.useFakeTimers();
  fx.unmountAll();
  vi.clearAllMocks();
  fx.geocode.mockResolvedValue([]);
  fx.reverse.mockResolvedValue([]);
});

afterEach(() => {
  fx.unmountAll();
  vi.useRealTimers();
});

describe('where the store map opens', () => {
  it('closed, it mounts nothing and looks nothing up', () => {
    const picker = fx.mount(StoreLocationPicker, {
      visible: false, current: null, address: { line: '12 Regent Street', city: 'Georgetown' }, device: phone, onConfirm: vi.fn(), onClose: vi.fn(),
    });

    expect(only(picker.output, 'Modal').props.visible).toBe(false);
    expect(named(picker.output, 'PickerBody')).toHaveLength(0);
    expect(fx.geocode).not.toHaveBeenCalled();
  });

  it('at the typed address, looked up in Guyana, when the phone finds it', async () => {
    fx.geocode.mockResolvedValue([typedAddressPoint]);
    const { body } = await open({ device: phone });

    expect(fx.geocode).toHaveBeenCalledExactlyOnceWith('12 Regent Street, Georgetown, Guyana');
    expect(only(body.output, 'MapView').props.initialRegion).toMatchObject(typedAddressPoint);
    expect(texts(body)).toContain('Starting at the address you typed.');
    expect(confirmButton(body).props).toMatchObject({ label: 'Confirm store location', disabled: false });
  });

  it('at the phone, as a suggestion said out loud, when the address cannot be found', async () => {
    const { body } = await open({ device: phone });

    expect(only(body.output, 'MapView').props.initialRegion).toMatchObject(phone);
    expect(texts(body).join('\n')).toContain('We couldn’t find that address on the map. Starting where your phone is. If you’re not at the store, move the pin.');
    // The phone's position is offered, one tap away — never applied.
    expect(ofType(body.output, 'CircleChip').map((el) => el.props.label)).toContain('Go to where my phone is');
  });

  it('on the pin already placed, with no lookup at all', async () => {
    const placed = { latitude: 6.8102, longitude: -58.1623 };
    const { body } = await open({ current: placed, device: phone });

    expect(fx.geocode).not.toHaveBeenCalled();
    expect(only(body.output, 'MapView').props.initialRegion).toMatchObject(placed);
    expect(texts(body)).toContain('This is where your store’s pin is now.');
  });

  it('shows a loading state, not a map, until the start is decided', () => {
    fx.geocode.mockReturnValue(new Promise(() => {}));
    const picker = fx.mount(StoreLocationPicker, {
      visible: true, current: null, address: { line: '12 Regent Street', city: 'Georgetown' }, device: null, onConfirm: vi.fn(), onClose: vi.fn(),
    });
    const body = fx.mount(named(picker.output, 'PickerBody')[0]!.type as (p: unknown) => unknown, named(picker.output, 'PickerBody')[0]!.props);

    expect(ofType(body.output, 'MapView')).toHaveLength(0);
    expect(ofType(body.output, 'LoadingBlock')).toHaveLength(1);
    expect(confirmButton(body).props.disabled).toBe(true);
  });
});

describe('confirming the store location', () => {
  it('in the town centre, Confirm waits until the owner has moved the map', async () => {
    const { body, onConfirm } = await open({ address: { line: '', city: 'Georgetown' } });

    expect(only(body.output, 'MapView').props.initialRegion).toMatchObject(GEORGETOWN);
    expect(texts(body)).toContain('Starting in Georgetown. Move the map to your store.');
    expect(confirmButton(body).props).toMatchObject({ label: 'Move the map to your store', disabled: true });
    confirmButton(body).props.onPress();
    expect(onConfirm).not.toHaveBeenCalled();

    // The first settle reports the start itself: not a move.
    await settleAt(body, GEORGETOWN);
    expect(confirmButton(body).props.disabled).toBe(true);

    await settleAt(body, entrance);
    expect(confirmButton(body).props).toMatchObject({ label: 'Confirm store location', disabled: false });
  });

  it('confirms the spot under the pin with its own address line — not the phone, not the start', async () => {
    fx.reverse.mockResolvedValue([{ name: '14 Regent St', city: 'Georgetown' }]);
    const { body, onConfirm } = await open({ device: phone });

    await settleAt(body, entrance);
    await nameSpot(body);
    expect(texts(body)).toContain('14 Regent St, Georgetown');
    confirmButton(body).props.onPress();

    expect(fx.reverse).toHaveBeenLastCalledWith(entrance);
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ ...entrance, address: '14 Regent St, Georgetown' });
  });

  it('a moved pin drops the old spot’s address line until its own arrives', async () => {
    fx.reverse.mockResolvedValueOnce([{ name: 'Stabroek Market', city: 'Georgetown' }]);
    const { body, onConfirm } = await open({ device: phone });
    await nameSpot(body);
    expect(texts(body)).toContain('Stabroek Market, Georgetown');

    await settleAt(body, entrance);

    expect(texts(body).join('\n')).not.toContain('Stabroek Market');
    expect(texts(body)).toContain('Finding the address\u2026');
    // Confirmed before the new spot is named: no line at all, never the old spot's.
    confirmButton(body).props.onPress();
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ ...entrance, address: null });
  });

  it('a slow answer for an earlier spot never overwrites the answer for the spot under the pin', async () => {
    let answerFirst: (value: unknown) => void = () => {};
    fx.reverse.mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }));
    fx.reverse.mockResolvedValue([{ name: '14 Regent St', city: 'Georgetown' }]);
    const { body, onConfirm } = await open({ device: phone });

    // The lookup for where the map opened is still out when the owner moves on.
    await nameSpot(body);
    await settleAt(body, entrance);
    await nameSpot(body);
    expect(texts(body)).toContain('14 Regent St, Georgetown');

    answerFirst([{ name: 'Somewhere Else', city: 'Georgetown' }]);
    await flush();
    body.render();

    expect(texts(body)).toContain('14 Regent St, Georgetown');
    confirmButton(body).props.onPress();
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ ...entrance, address: '14 Regent St, Georgetown' });
  });

  it('a spot the phone cannot name shows its coordinates and confirms with no address line', async () => {
    const { body, onConfirm } = await open({ device: phone });

    await settleAt(body, entrance);
    await nameSpot(body);
    expect(texts(body)).toContain('6.81390, -58.15920');
    confirmButton(body).props.onPress();

    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ ...entrance, address: null });
  });

  it('a tap on the map glides the pin to the tapped spot', async () => {
    const { body } = await open({ device: phone });
    const map = only(body.output, 'MapView');
    const animateToRegion = vi.fn();
    map.props.ref.current = { animateToRegion };

    map.props.onPress({ nativeEvent: { coordinate: entrance } });

    expect(animateToRegion).toHaveBeenCalledExactlyOnceWith({ ...entrance, latitudeDelta: 0.004, longitudeDelta: 0.004 }, 320);
  });

  it('while a save is running, Confirm is busy and cannot send twice; a refusal is shown in its own words', async () => {
    const { body, onConfirm } = await open({ current: entrance, saving: true, error: 'That pin is outside Guyana, where Swift works today. Move it to the entrance of your store.' });

    expect(confirmButton(body).props).toMatchObject({ loading: true });
    confirmButton(body).props.onPress();
    expect(onConfirm).not.toHaveBeenCalled();
    const refusal = ofType(body.output, 'T').find((el) => el.props.tone === 'error');
    expect(refusal?.props.children).toBe('That pin is outside Guyana, where Swift works today. Move it to the entrance of your store.');
  });

  it('closing places nothing', async () => {
    const { body, onClose, onConfirm } = await open({ device: phone });

    ofType(body.output, 'CircleChip').find((el) => el.props.label === 'Close without placing the pin')!.props.onPress();

    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
