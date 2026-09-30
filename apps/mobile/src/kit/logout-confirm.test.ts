import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Owner: "logging out of any account — the confirmation 'should we log you
// out', like every other app. Implement it code-wise safely."
//
// useLogoutConfirm is the one implementation every log-out control uses. These
// tests drive the real hook on a small per-instance hook runtime (the pattern
// VendorStack.entry.test.ts uses): a press changes state, a re-render shows the
// result, an unmount runs the effect cleanups. PopupCard and the buttons are
// stand-ins, so the dialog's own props are what gets pressed: `onClose` is
// where a backdrop tap, Android's back button and the accessibility escape all
// arrive, and `onDismissed` is iOS reporting that the modal is gone.
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

interface Mounted<R> {
  readonly output: R;
  render: () => R;
  unmount: () => void;
}

const fx = vi.hoisted(() => {
  let active: Instance | null = null;
  const mounted = new Set<{ unmount: () => void }>();

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
  function mount<P, R>(component: (props: P) => R, props: P): Mounted<R> {
    const instance: Instance = { slots: [], cursor: 0, effects: [], dirty: false };
    let output!: R;
    let live = true;
    const render = (): R => {
      if (!live) throw new Error('A view was rendered after it unmounted.');
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
    const view: Mounted<R> = {
      get output() {
        return output;
      },
      render,
      unmount() {
        if (!live) return;
        live = false;
        mounted.delete(view);
        for (const s of instance.slots) {
          if (typeof s.cleanup === 'function') s.cleanup();
        }
      },
    };
    mounted.add(view);
    render();
    return view;
  }

  return {
    hooks,
    mount,
    unmountAll: () => {
      for (const view of [...mounted]) view.unmount();
    },
  };
});

// The auth store, reduced to what the confirm reads. logout() does to the
// principal boundary what the real one does: a new generation, signed out.
const auth = vi.hoisted(() => {
  const state = {
    isAuthenticated: true,
    sessionGeneration: 7,
    logout: vi.fn(() => {
      state.isAuthenticated = false;
      state.sessionGeneration += 1;
    }),
  };
  return state;
});

const rn = vi.hoisted(() => ({ Platform: { OS: 'ios' as 'ios' | 'android' } }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { default?: Record<string, unknown> }>();
  return { ...actual, ...fx.hooks, default: { ...(actual.default ?? actual), ...fx.hooks } };
});
vi.mock('react-native', () => ({ Platform: rn.Platform, View: 'View' }));
vi.mock('@swift/ui', () => ({ space: { sm: 8, md: 12, xl: 20 } }));
vi.mock('../stores/authStore', () => ({
  useAuthStore: Object.assign((select: (state: typeof auth) => unknown) => select(auth), { getState: () => auth }),
}));
vi.mock('./card', () => ({ PopupCard: 'PopupCard', PopupTitle: 'PopupTitle' }));
vi.mock('./button', () => ({ PillButton: 'PillButton' }));
vi.mock('./rows', () => ({ IconChip: 'IconChip' }));
vi.mock('./text', () => ({ T: 'T' }));

import { useLogoutConfirm, type LogoutConfirm, type LogoutConfirmOptions } from './logout-confirm';

interface Element {
  type: unknown;
  props: any;
}

function isElement(node: unknown): node is Element {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

/** Every element in a returned tree, the root included. */
function elements(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
  } else if (isElement(node)) {
    found.push(node);
    elements(node.props?.children, found);
  }
  return found;
}

const CUSTOMER_BODY = 'Your cart and session leave this device; your account keeps everything.';

function Host(options: LogoutConfirmOptions): LogoutConfirm {
  return useLogoutConfirm(options);
}

function mountConfirm(options: Partial<LogoutConfirmOptions> = {}) {
  return fx.mount(Host, { body: CUSTOMER_BODY, ...options });
}

/** The dialog the hook hands back — a PopupCard, rendered by the screen. */
function dialog(view: Mounted<LogoutConfirm>): Element {
  const card = view.output.logoutDialog as unknown as Element;
  expect(card.type).toBe('PopupCard');
  return card;
}

function button(view: Mounted<LogoutConfirm>, label: string): Element {
  const found = elements(dialog(view)).filter((el) => el.type === 'PillButton' && el.props.label === label);
  expect(found, `exactly one "${label}" button`).toHaveLength(1);
  return found[0]!;
}

/** requestLogout, as the screen's own "Log out" control calls it. */
function pressLogOutControl(view: Mounted<LogoutConfirm>) {
  view.output.requestLogout();
  view.render();
}

// requestAnimationFrame is a platform timer: hold every callback until a test
// presents a frame, so "two frames later" is something a test can step through.
const frames = new Map<number, (time: number) => void>();
let nextFrame = 1;
function presentFrame() {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
}

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.sessionGeneration = 7;
  auth.logout.mockClear();
  rn.Platform.OS = 'ios';
  frames.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  // The one-second floor is a timer: fake it, so a test says when time passes.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  fx.unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a log-out control asks first', () => {
  it('opens the dialog and ends nothing', () => {
    const view = mountConfirm();
    expect(dialog(view).props.visible, 'nothing is asked until the control is pressed').toBe(false);

    pressLogOutControl(view);

    expect(dialog(view).props.visible).toBe(true);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('shows the Profile design: the log-out chip, one title, the surface’s own words and two choices', () => {
    const view = mountConfirm();
    pressLogOutControl(view);
    const tree = elements(dialog(view));

    expect(tree.filter((el) => el.type === 'IconChip').map((el) => el.props.icon)).toEqual(['log-out']);
    expect(tree.filter((el) => el.type === 'PopupTitle').map((el) => el.props.children)).toEqual(['Log out of Swift?']);
    expect(tree.filter((el) => el.type === 'T').map((el) => el.props.children)).toEqual([CUSTOMER_BODY]);
    expect(tree.filter((el) => el.type === 'PillButton').map((el) => [el.props.label, el.props.variant])).toEqual([
      ['Log out', undefined],
      ['Stay signed in', 'soft'],
    ]);
  });

  it('carries each surface’s own title, words and labels', () => {
    const view = mountConfirm({
      title: 'Sign out of Swift?',
      body: 'A photo you haven’t saved yet is discarded.',
      confirmLabel: 'Sign out',
      cancelLabel: 'Stay signed in',
      confirmIcon: 'log-out',
    });
    pressLogOutControl(view);
    const tree = elements(dialog(view));

    expect(tree.find((el) => el.type === 'PopupTitle')?.props.children).toBe('Sign out of Swift?');
    expect(tree.find((el) => el.type === 'T')?.props.children).toBe('A photo you haven’t saved yet is discarded.');
    expect(button(view, 'Sign out').props.icon).toBe('log-out');
  });
});

describe('staying signed in', () => {
  it('"Stay signed in" closes the dialog and ends nothing', () => {
    const view = mountConfirm();
    pressLogOutControl(view);

    button(view, 'Stay signed in').props.onPress();
    view.render();

    expect(dialog(view).props.visible).toBe(false);
    // iOS reports the closed dialog gone: still nothing to end.
    dialog(view).props.onDismissed();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.isAuthenticated).toBe(true);
  });

  it('a backdrop tap or Android’s back button closes the dialog and ends nothing', () => {
    const view = mountConfirm();
    pressLogOutControl(view);

    // PopupCard wires the backdrop, Modal.onRequestClose (Android back) and the
    // accessibility escape to this one prop.
    dialog(view).props.onClose();
    view.render();

    expect(dialog(view).props.visible).toBe(false);
    dialog(view).props.onDismissed();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('the dialog can be opened again after staying', () => {
    const view = mountConfirm();
    pressLogOutControl(view);
    button(view, 'Stay signed in').props.onPress();
    view.render();

    pressLogOutControl(view);

    expect(dialog(view).props.visible).toBe(true);
    expect(auth.logout).not.toHaveBeenCalled();
  });
});

describe('"Log out"', () => {
  it('closes the dialog first, and ends the session once iOS reports the dialog gone', () => {
    const view = mountConfirm();
    pressLogOutControl(view);

    button(view, 'Log out').props.onPress();
    view.render();

    expect(dialog(view).props.visible, 'the dialog closes before the session ends').toBe(false);
    expect(auth.logout, 'nothing ends while the dialog is still on screen').not.toHaveBeenCalled();

    dialog(view).props.onDismissed();

    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(auth.isAuthenticated).toBe(false);
  });

  it('ends the session exactly once on a double tap', () => {
    const view = mountConfirm();
    pressLogOutControl(view);
    const logOut = button(view, 'Log out').props.onPress;

    // Two taps land before React re-renders, then a third on the closing dialog.
    logOut();
    logOut();
    view.render();
    button(view, 'Log out').props.onPress();
    view.render();
    dialog(view).props.onDismissed();
    dialog(view).props.onDismissed();

    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('cannot be taken back once pressed: Stay, the backdrop and the control are all too late', () => {
    const view = mountConfirm();
    pressLogOutControl(view);
    const stay = button(view, 'Stay signed in').props.onPress;
    const backdrop = dialog(view).props.onClose;

    button(view, 'Log out').props.onPress();
    stay();
    backdrop();
    view.output.requestLogout();
    view.render();

    expect(dialog(view).props.visible).toBe(false);
    dialog(view).props.onDismissed();
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('on Android, ends the session two frames after the dialog closes, once', () => {
    rn.Platform.OS = 'android';
    const view = mountConfirm();
    pressLogOutControl(view);

    button(view, 'Log out').props.onPress();
    view.render();
    expect(dialog(view).props.visible).toBe(false);

    presentFrame();
    expect(auth.logout, 'the first frame only commits the close').not.toHaveBeenCalled();
    presentFrame();
    expect(auth.logout).toHaveBeenCalledTimes(1);

    view.render();
    presentFrame();
    presentFrame();
    view.unmount();
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('still ends the session, once, a second later if the dialog’s own signal can no longer come', () => {
    // ProfileScreen renders the dialog under its error branch and its loaded
    // branch. A refetch that lands mid-fade re-renders it elsewhere: the old
    // Modal is torn down and iOS never reports it gone, while the screen stays.
    const view = mountConfirm();
    pressLogOutControl(view);
    button(view, 'Log out').props.onPress();
    view.render();
    const lost = dialog(view).props.onDismissed;

    vi.advanceTimersByTime(999);
    expect(auth.logout, 'the fade gets its time first').not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(auth.logout).toHaveBeenCalledTimes(1);

    lost();
    view.render();
    vi.advanceTimersByTime(5000);
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('the floor never adds a second exit after the real signal', () => {
    const view = mountConfirm();
    pressLogOutControl(view);
    button(view, 'Log out').props.onPress();
    view.render();

    vi.advanceTimersByTime(300);
    dialog(view).props.onDismissed();
    vi.advanceTimersByTime(5000);

    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('still ends the session if the screen goes away while the dialog is closing', () => {
    const view = mountConfirm();
    pressLogOutControl(view);
    button(view, 'Log out').props.onPress();
    view.render();
    const late = dialog(view).props.onDismissed;

    view.unmount();

    expect(auth.logout, 'the person asked to leave').toHaveBeenCalledTimes(1);
    late();
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });

  it('control: a screen that goes away with nothing confirmed ends nothing', () => {
    const view = mountConfirm();
    pressLogOutControl(view);

    view.unmount();

    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('does not end a session that already ended some other way meanwhile', () => {
    const view = mountConfirm();
    pressLogOutControl(view);
    button(view, 'Log out').props.onPress();
    view.render();

    // The session expired, or the server refused a refresh, while the dialog closed.
    auth.isAuthenticated = false;
    auth.sessionGeneration += 1;
    dialog(view).props.onDismissed();

    expect(auth.logout).not.toHaveBeenCalled();
    view.render();
    expect(dialog(view).props.visible).toBe(false);
  });

  it('never wedges the control: after a dropped exit, whoever signs in next is asked again', () => {
    const view = mountConfirm();
    pressLogOutControl(view);
    button(view, 'Log out').props.onPress();
    view.render();
    auth.isAuthenticated = false;
    auth.sessionGeneration += 1;
    dialog(view).props.onDismissed();

    // Someone signs in and this screen is still up.
    auth.isAuthenticated = true;
    auth.sessionGeneration += 1;
    view.render();
    pressLogOutControl(view);

    expect(dialog(view).props.visible).toBe(true);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('hands a wrapped exit the store’s own logout and runs it once', () => {
    const calls: string[] = [];
    const onLogout = vi.fn((logout: () => void) => {
      calls.push('intent:null');
      logout();
    });
    auth.logout.mockImplementationOnce(() => {
      calls.push('logout');
      auth.isAuthenticated = false;
      auth.sessionGeneration += 1;
    });
    const view = mountConfirm({ onLogout });
    pressLogOutControl(view);

    button(view, 'Log out').props.onPress();
    view.render();
    expect(onLogout).not.toHaveBeenCalled();
    dialog(view).props.onDismissed();

    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(onLogout.mock.calls[0]![0]).toBe(auth.logout);
    expect(calls).toEqual(['intent:null', 'logout']);
  });
});

describe('a guest', () => {
  it('has no session to confirm: the control leaves at once and nothing is asked', () => {
    auth.isAuthenticated = false;
    const view = mountConfirm();

    pressLogOutControl(view);

    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(dialog(view).props.visible).toBe(false);
  });
});
