import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// [FEE-STATUS · owner 25 Oct 2026] A fee notice never names a date that has passed as a deadline:
// the store Account notice read "Weekly fee due by <grace end>" whatever that date was.
vi.mock('react-native', () => ({ Pressable: 'Pressable', TextInput: 'TextInput', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('@swift/ui', () => {
  const token: any = new Proxy({}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, font: token, fontSize: token, radius: token, space: token };
});
vi.mock('../../kit', () => ({ T: 'T', TonePill: 'TonePill', PillButton: 'PillButton', useLogoutConfirm: () => () => {} }));
vi.mock('../../components/onboarding/BackToSwiftButton', () => ({ BackToSwiftButton: () => null }));
import { VendorBillingNotice } from './shared';

function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  const props = (node as ReactElement<{ children?: unknown; label?: string }>).props;
  return props ? [props.label, text(props.children)].filter(Boolean).join(' ') : '';
}
const DAY = 86_400_000;

describe('store billing notice deadline [FEE-STATUS]', () => {
  it('names the grace deadline while it is ahead', () => {
    const ahead = new Date(Date.now() + 2 * DAY).toISOString();
    expect(text(VendorBillingNotice({ sub: { status: 'PAST_DUE', isInGracePeriod: true, gracePeriodEnd: ahead, amountDueGyd: 15000 }, onPay: () => {} }))).toMatch(/Weekly fee due by \S/);
  });
  it('a grace deadline that has passed is never a "due by" date', () => {
    const passed = new Date(Date.now() - 2 * DAY).toISOString();
    const shown = text(VendorBillingNotice({ sub: { status: 'PAST_DUE', isInGracePeriod: true, gracePeriodEnd: passed, amountDueGyd: 15000 }, onPay: () => {} }));
    expect(shown).toContain('Weekly fee due');
    expect(shown).not.toMatch(/due by/);
  });
});
