import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [COORD ruling 22 Oct 2026 · row 628] The weekly fee at partner sign-up. Before a mover saves
// their first vehicle, or an owner creates their store, the phone shows the server's amount for
// THAT vehicle or business, the server's words (what it covers, when it starts, how it is paid,
// the 14-day rule) and an unticked "I understand the weekly fee". The button waits for the tick;
// sign-up sends the words' version and the amount on screen; the server records it. An API with
// no words (older than the tick) asks nothing and is sent nothing.
// ---------------------------------------------------------------------------

vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('@swift/ui', () => ({ color: { brand: { 500: 'brand-500' }, text: { muted: 'muted' }, border: { subtle: 'subtle' } }, radius: { lg: 16 }, space: { xs: 4, sm: 8, md: 12 } }));
vi.mock('../kit', () => ({ T: 'T' }));

import { FEE_TICK_COPY, feeTick, feeTickError, type PartnerPricing } from './partnerPricing';
import { WeeklyFeeTerms } from '../components/onboarding/WeeklyFeeTerms';

const TERMS = {
  version: 'v1',
  items: [
    { heading: 'What it covers', text: 'The Swift app. Keep 100%.' },
    { heading: 'When it starts', text: 'Only after approval.' },
    { heading: 'How you pay', text: 'MMG checkout in the app.' },
    { heading: 'If the price changes', text: '14 days notice.' },
  ],
  tick: 'I understand the weekly fee.',
};
const pricing = (extra: Partial<PartnerPricing> = {}) => ({ countryCode: 'GY', currencyCode: 'GYD', currencySymbol: '$', isActive: true, trialDays: 14, franchise: null, feeTerms: TERMS, ...extra }) as PartnerPricing;

function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}
function find(node: unknown, pick: (n: { type?: unknown; props?: Record<string, unknown> }) => boolean): { props: Record<string, unknown> } | null {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const c of node) { const f = find(c, pick); if (f) return f; } return null; }
  const n = node as { type?: unknown; props?: Record<string, unknown> };
  if (pick(n)) return n as { props: Record<string, unknown> };
  return find(n.props?.['children'], pick);
}

describe('feeTick — the tick for the fee on screen', () => {
  it('names the server’s words, the key the tick is given to, and what sign-up sends', () => {
    const fee = feeTick(pricing(), 6000);
    expect(fee).toEqual({ kind: 'tick', terms: TERMS, key: 'v1|GYD|6000', ack: { version: 'v1', amount: 6000, currencyCode: 'GYD' } });
  });

  it('a different amount (another vehicle, a new price) is a different key, so a given tick does not carry over', () => {
    const a = feeTick(pricing(), 6000);
    const b = feeTick(pricing(), 8000);
    expect(a.kind === 'tick' && b.kind === 'tick' && a.key !== b.key).toBe(true);
  });

  it('an API older than the tick (no words) asks nothing and sends nothing; no confirmed quote asks nothing yet', () => {
    expect(feeTick(pricing({ feeTerms: undefined }), 6000)).toEqual({ kind: 'none' });
    expect(feeTick(pricing(), null)).toEqual({ kind: 'none' });
    expect(feeTick(undefined, 6000)).toEqual({ kind: 'none' });
  });

  it('words that are not the words — or a fee that is not a fee — are refused, never ticked', () => {
    for (const feeTerms of [null, {}, { ...TERMS, version: '' }, { ...TERMS, tick: ' ' }, { ...TERMS, items: [] }, { ...TERMS, items: [{ heading: 'x' }] }]) {
      expect(feeTick(pricing({ feeTerms: feeTerms as never }), 6000)).toEqual({ kind: 'invalid' });
    }
    expect(feeTick(pricing(), 0)).toEqual({ kind: 'invalid' });
    expect(feeTick(pricing(), 6000.5)).toEqual({ kind: 'invalid' });
  });
});

describe('feeTickError — the server’s refusal of a tick is shown in its own words', () => {
  const err = (code: string, message?: string) => ({ response: { data: { error: { code, message } } } });
  it('names the fee changing, the words changing and a missing tick; nothing else', () => {
    expect(feeTickError(err('WEEKLY_FEE_CHANGED', 'The weekly fee is now $8,000 a week.'))).toBe('The weekly fee is now $8,000 a week.');
    expect(feeTickError(err('WEEKLY_FEE_TERMS_CHANGED', 'New words.'))).toBe('New words.');
    expect(feeTickError(err('WEEKLY_FEE_ACK_REQUIRED', 'Tick it.'))).toBe('Tick it.');
    expect(feeTickError(err('AGREEMENT_REQUIRED', 'Agree.'))).toBeNull();
    expect(feeTickError(new Error('network'))).toBeNull();
  });
});

describe('WeeklyFeeTerms — the amount, the server’s words and an unticked tick', () => {
  it('shows the amount for this choice and every one of the server’s lines, and a checkbox named by the tick', () => {
    const fee = feeTick(pricing(), 6000);
    const onToggle = vi.fn();
    const tree = WeeklyFeeTerms({ fee, ticked: false, onToggle });
    const text = textOf(tree);
    expect(text).toContain('Your weekly fee: $6,000/week');
    for (const item of TERMS.items) expect(text).toContain(`${item.heading}: ${item.text}`);
    const box = find(tree, (n) => n.props?.['accessibilityRole'] === 'checkbox')!;
    expect(box.props['accessibilityLabel']).toBe('I understand the weekly fee.');
    expect(box.props['accessibilityState']).toEqual({ checked: false });
    (box.props['onPress'] as () => void)();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect((find(WeeklyFeeTerms({ fee, ticked: true, onToggle }), (n) => n.props?.['accessibilityRole'] === 'checkbox')!.props['accessibilityState'])).toEqual({ checked: true });
  });

  it('shows nothing when there is nothing to tick', () => {
    expect(WeeklyFeeTerms({ fee: { kind: 'none' }, ticked: false, onToggle: () => {} })).toBeNull();
    expect(WeeklyFeeTerms({ fee: { kind: 'invalid' }, ticked: false, onToggle: () => {} })).toBeNull();
  });
});

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('[row 628] both sign-up screens show the fee block and wait for the tick', () => {
  it.each([
    ['src/modules/mover/screens/MoverOnboardingScreen.tsx', /disabled=\{!gate\.ok \|\| !valid \|\| feeAsk !== null/],
    ['src/modules/vendor/screens/BusinessSetup.tsx', /disabled=\{!gate\.ok \|\| ask !== null\}/],
  ])('%s', (file, disabled) => {
    const s = src(file);
    // The tick is computed for the quote the gate confirmed, and given to that amount only.
    expect(s).toContain('feeTick(pricing.data, gate.ok ? gate.quote.rate : null)');
    expect(s).toContain("const feeTicked = fee.kind === 'tick' && feeTickedFor === fee.key;");
    // The block sits with the agreement tick, the button waits for it, and the submit restates it.
    expect(s).toContain('<WeeklyFeeTerms fee={fee} ticked={feeTicked}');
    expect(s).toMatch(disabled);
    expect(s).toContain('if (feeAsk) return;');
    // Sign-up sends the tick only when the server asked for it, with the amount on screen.
    expect(s).toContain("...(fee.kind === 'tick' && { weeklyFeeAck: fee.ack })");
    // A refused tick reads the price again.
    expect(s).toMatch(/onError: \(e\) => \{ if \(feeTickError\(e\)\) void refetchPricing\(\); \}/);
  });

  it('the button asks for the tick by name', () => {
    expect(FEE_TICK_COPY.ask).toBe('Tick “I understand the weekly fee” first');
  });
});
