import React from 'react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { color, motion } from '@swift/ui';

// ---------------------------------------------------------------------------
// [Q6] THE CODE BOXES COLLAPSED INTO SIX THIN LINES. On the owner's phone the
// emergency-contact "Confirm" popup drew its 6-digit entry as six 1–2px
// vertical lines squeezed together in the middle of the card. Every box is
// `flex: 1` with a ceiling and no floor, so its flex basis is its border, and
// two things reduce it to exactly that: a parent that centres CodeInput
// (nothing stretches the row), and — with the row at full width — React
// Native 0.85's Yoga itself, in a 10pt band of row widths that a PopupCard on
// a 428/430pt iPhone and the driver's PIN sheet on a 393pt iPhone both hit.
// CodeInput is also the door to money (step-up), to a ride (the driver's PIN),
// to a delivery (the rider's door PIN) and to a counter pickup, so it must
// hold its size in ANY parent.
//
// Rendered the kit's way (card.test.ts): the component is called as a plain
// function with the native surface stubbed, and its styles are read off the
// element tree. The design tokens are the REAL ones on purpose — the fit
// arithmetic below has to use the gap and paddings a phone actually gets.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  window: { width: 390, height: 844, scale: 3, fontScale: 1 },
  effects: [] as Array<() => void>,
  shared: [] as Array<{ value: unknown }>,
}));

// A plain function call has no renderer behind it, so the two React hooks the
// component uses are answered here: refs hold their value, effects are kept
// for the test to run.
vi.mock('react', async (original) => {
  const actual = await original<Record<string, any>>();
  const hooks = {
    useRef: (value: unknown) => ({ current: value }),
    useEffect: (effect: () => void) => {
      mocks.effects.push(effect);
    },
  };
  return { ...actual, ...hooks, default: { ...actual['default'], ...hooks } };
});

vi.mock('react-native', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => mocks.window,
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (value: unknown) => {
    const shared = { value };
    mocks.shared.push(shared);
    return shared;
  },
  useAnimatedStyle: (style: () => unknown) => style(),
  withSequence: (...steps: unknown[]) => ({ sequence: steps }),
  withTiming: (to: number, config: unknown) => ({ to, config }),
}));

// Portrait, no side insets: PopupCard's side gutters are then its own tokens.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('./text', () => ({ T: 'T' }));

import { CodeInput } from './code-input';
import { PopupCard } from './card';

type El = React.ReactElement<Record<string, any>, string>;

const flat = (style: unknown): Record<string, any> =>
  Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flat)) : ((style as Record<string, any>) ?? {});

function render(props: Partial<Parameters<typeof CodeInput>[0]> = {}) {
  mocks.effects = [];
  mocks.shared = [];
  const onChange = vi.fn();
  const root = CodeInput({ value: '', onChange, ...props }) as El;
  const [row, input] = React.Children.toArray(root.props['children']) as El[];
  const boxes = React.Children.toArray(row!.props['children']) as El[];
  return { root, row: row!, input: input!, boxes, onChange };
}

/** The widest a code row can be inside a PopupCard on a phone `width` points
 *  wide — read off PopupCard's own rendered styles, never restated. */
function popupContentWidth(width: number): number {
  const modal = PopupCard({ visible: true, onClose: vi.fn(), children: null }) as El;
  const keyboardLayer = modal.props['children'] as El;
  const backdrop = keyboardLayer.props['children'] as El;
  const sheet = backdrop.props['children'] as El;
  const scroll = sheet.props['children'] as El;
  const scrim = flat(backdrop.props['style']);
  const card = flat(sheet.props['style']);
  const content = flat(scroll.props['contentContainerStyle']);
  const cardWidth = Math.min(width - scrim['paddingLeft'] - scrim['paddingRight'], card['maxWidth']);
  return cardWidth - 2 * content['padding'];
}

/** A caller's code length, read from its source (the constant is module-local). */
function lengthConstant(file: string, name: string): number {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const found = new RegExp(`const ${name} = (\\d+);`).exec(source);
  expect(found, `${name} in ${file}`).not.toBeNull();
  return Number(found![1]);
}

// Every iOS text size, as React Native reports it (RCTAccessibilityManager's
// multipliers, xSmall through the largest accessibility size).
const FONT_SCALES = [0.823, 0.882, 0.941, 1, 1.118, 1.235, 1.353, 1.786, 2.143, 2.643, 3.143, 3.571];

beforeEach(() => {
  mocks.window = { width: 390, height: 844, scale: 3, fontScale: 1 };
});

describe('CodeInput holds its size in any parent [Q6]', () => {
  it('stretches its own tap target and its digit row, so a centring parent cannot shrink-wrap them', () => {
    const { root, row } = render();

    expect(root.type).toBe('Pressable');
    expect(flat(root.props['style'])).toMatchObject({ alignSelf: 'stretch' });
    expect(row.type).toBe('Animated.View');
    expect(flat(row.props['style'])).toMatchObject({ flexDirection: 'row', alignSelf: 'stretch' });
  });

  it('gives all six boxes one definite floor — the thicker-bordered active box too — under the same 2x cap as the ceiling', () => {
    // ONE floor, not merely a floor. With `flex: 1` and no floor, each box's
    // flex basis is its border: 4pt for the active box, 2pt for the rest.
    // React Native 0.85's Yoga then collapses a row that HAS its full width:
    // when the active first box's share tips just past the ceiling, its first
    // flex pass freezes every box at the ceiling, overshoots the free space,
    // and the second pass (`flex: 1` never shrinks) leaves each box at its
    // border. A shared floor above the borders gives all six the same basis.
    for (const fontScale of FONT_SCALES) {
      mocks.window = { ...mocks.window, fontScale };
      for (const value of ['', '12', '123456']) {
        const styles = render({ value }).boxes.map((box) => flat(box.props['style']));
        const floors = new Set(styles.map((style) => style['minWidth']));
        expect(floors.size, `one floor for all six, "${value}" @${fontScale}`).toBe(1);
        const [floor] = [...floors] as number[];
        expect(Number.isFinite(floor), `a definite minWidth @${fontScale}`).toBe(true);
        // A real box, never its border: at least the default-size floor.
        expect(floor, `floor @${fontScale}`).toBeGreaterThanOrEqual(32);
        for (const style of styles) {
          expect(style['flex'], `flex @${fontScale}`).toBe(1);
          expect(floor, `floor under ceiling @${fontScale}`).toBeLessThanOrEqual(style['maxWidth']);
        }
      }
    }

    // A short code shows the scaling plainly (the fit cap does not bite yet):
    // floor and ceiling move together, and stop together at 2x.
    const at = (fontScale: number) => {
      mocks.window = { ...mocks.window, fontScale };
      return flat(render({ length: 4 }).boxes[0]!.props['style']);
    };
    expect(at(1)).toMatchObject({ minWidth: 32, maxWidth: 52 });
    expect(at(1.5)).toMatchObject({ minWidth: 48, maxWidth: 78 });
    expect(at(3.12)).toEqual(at(2));
  });

  it('fits six boxes — and every caller’s code, the ride PIN included — inside a PopupCard on a 320pt phone at every text size', () => {
    // The narrowest supported card: 320 − 2 × 16 (scrim gutters) − 2 × 24
    // (card padding) = 240pt.
    const narrowest = popupContentWidth(320);
    expect(narrowest).toBe(240);

    const lengths = new Set([
      6, // the default: emergency-contact confirm
      lengthConstant('../modules/mover/screens/ActiveJobScreen.tsx', 'RIDE_PIN_LENGTH'), // driver PIN + rider door PIN
      lengthConstant('../modules/vendor/screens/VendorOrderDetailScreen.tsx', 'PICKUP_CODE_LENGTH'), // counter pickup
      lengthConstant('../components/StepUpSheet.tsx', 'CODE_LEN'), // money step-up
    ]);

    for (const length of lengths) {
      for (const fontScale of FONT_SCALES) {
        mocks.window = { width: 320, height: 568, scale: 2, fontScale };
        const { row, boxes } = render({ length });
        expect(boxes).toHaveLength(length);
        const gap = flat(row.props['style'])['gap'];
        const floors = boxes.map((box) => flat(box.props['style'])['minWidth'] as number);
        expect(floors.every(Number.isFinite), `definite floors, ${length} @${fontScale}`).toBe(true);
        const tightest = floors.reduce((sum, w) => sum + w, 0) + (length - 1) * gap;
        expect(tightest, `${length} boxes @${fontScale}`).toBeLessThanOrEqual(narrowest);
      }
    }

    // The arithmetic, pinned at the default text size: 6 × 32 + 5 × 8 = 232.
    mocks.window = { width: 320, height: 568, scale: 2, fontScale: 1 };
    const six = render();
    expect(six.boxes.map((box) => flat(box.props['style'])['minWidth'])).toEqual([32, 32, 32, 32, 32, 32]);
    expect(flat(six.row.props['style'])['gap']).toBe(8);
  });

  // Regression pin, not new behaviour: the Q6 change touches layout only, and
  // this is what it must leave exactly as it was.
  it('keeps the ceremony: label, hidden number-pad input, capped glyph, brand active box, error colours and shake', () => {
    const { root, input, boxes, onChange } = render({ value: '12' });

    expect(root.props['accessibilityLabel']).toBe('Code entry');
    expect(input.type).toBe('TextInput');
    expect(input.props).toMatchObject({ value: '12', keyboardType: 'number-pad', maxLength: 6, autoFocus: true });
    expect(flat(input.props['style'])).toEqual({ position: 'absolute', opacity: 0, height: 1, width: 1 });
    input.props['onChangeText']('4a5-6789');
    expect(onChange).toHaveBeenCalledWith('456789');

    const focus = vi.fn();
    (input.props['ref'] as { current: unknown }).current = { focus };
    root.props['onPress']();
    expect(focus).toHaveBeenCalledOnce();

    const glyphs = boxes.map((box) => box.props['children'] as El);
    for (const glyph of glyphs) expect(glyph.props).toMatchObject({ variant: 'displayXl', tone: 'ink', maxFontSizeMultiplier: 2 });
    expect(glyphs.map((glyph) => glyph.props['children'])).toEqual(['1', '2', '', '', '', '']);
    expect(flat(boxes[2]!.props['style'])).toMatchObject({ borderWidth: 2, borderColor: color.brand[500] });
    expect(flat(boxes[3]!.props['style'])).toMatchObject({ borderWidth: 1, borderColor: color.border.strong });

    const failed = render({ value: '12', error: true });
    for (const box of failed.boxes) {
      expect(flat(box.props['style'])['borderColor']).toBe(color.error);
      expect((box.props['children'] as El).props['tone']).toBe('error');
    }
    const shake = mocks.shared[0]!;
    for (const effect of mocks.effects) effect();
    const instant = { duration: motion.duration.instant };
    expect(shake.value).toEqual({
      sequence: [-6, 6, -6, 6, 0].map((to) => ({ to, config: instant })),
    });
  });
});
