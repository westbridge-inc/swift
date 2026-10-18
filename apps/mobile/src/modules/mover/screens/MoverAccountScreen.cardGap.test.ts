import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// [OWNER 17 Oct, live test of build 11] On the driver Account screen the
// vehicle card ("Black Toyota Allion · HC1234 · Add photo …") and the "Your
// MMG pay link" card TOUCHED, while every other card had a gap: the screen
// stacks its cards with marginTop, and MmgPayLinkCard brought the store
// screen's marginBottom with no marginTop. This renders the screen with every
// optional card on and measures the space between each pair of cards.

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useState = (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined];
  const useEffect = () => undefined;
  return { ...actual, default: { ...actual, useState, useEffect }, useState, useEffect };
});
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View', Pressable: 'Pressable' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', MaterialCommunityIcons: 'MaterialCommunityIcons' }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../../../kit', () => ({
  Card: 'Card',
  Header: 'Header',
  LinkText: 'LinkText',
  LabeledInput: 'LabeledInput',
  PillButton: 'PillButton',
  Screen: 'Screen',
  SettingsRow: 'SettingsRow',
  T: 'T',
  TonePill: 'TonePill',
  useLogoutConfirm: () => ({ requestLogout: vi.fn(), logoutDialog: null }),
}));
vi.mock('../../../kit/controls', () => ({ Stars: 'Stars' }));
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../services/api', () => ({ driverApi: {} }));
const STANDING = { standing: 'GOOD', displayRating: 4.8, ratingBucket: '4.5+', ratingCount: 30, topRated: false, folded: { count: 0, average: null }, trend: [], topPositive: [], topNegative: [], coaching: [] };
vi.mock('../../../hooks', () => ({
  useMoverKind: () => ({
    kind: 'DRIVER',
    profile: { vehicleColor: 'Black', vehicleMake: 'Toyota', vehicleModel: 'Allion', licensePlate: 'HC1234', averageRating: 4.8, mmgPayUrl: null },
  }),
  useMoverStanding: () => ({ data: STANDING }),
  useVerificationStatus: () => ({ data: { roleVerified: true } }),
  useEarningsSummary: () => ({ data: { allTime: { total: 0 } } }),
  useMoverSubscription: () => ({ data: null }),
  useSetMoverBillingMethod: () => ({ mutate: vi.fn(), isPending: false }),
  useUploadVehiclePhoto: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));
vi.mock('../../../components/StandingCard', async (importOriginal) => importOriginal());
vi.mock('../../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionForPrincipal: vi.fn(),
  requireAuthSessionSnapshot: vi.fn(),
  useAuthStore: () => ({ user: { firstName: 'Dev', lastName: 'Driver' } }),
}));
vi.mock('../../../components/RoleSwitcherSheet', () => ({ RoleSwitcherSheet: 'RoleSwitcherSheet' }));
vi.mock('../../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn }) }));
vi.mock('../../../lib/stepUp', () => ({ isStepUpDismissed: () => false, serverMessage: () => '', fmtWhen: () => null }));
vi.mock('../../../lib/images', () => ({ mediaUrl: (u: string) => u }));
vi.mock('../../../components/billing/BillingSurfaces', () => ({ BillingStatusBlock: 'BillingStatusBlock', BillingStopControl: 'BillingStopControl' }));
vi.mock('../../../lib/billing', () => ({ resumeBillingMethod: () => 'NONE' }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: () => false }));

import { space } from '@swift/ui';
import { MoverAccountScreen } from './MoverAccountScreen';

type El = React.ReactElement<Record<string, any>>;

/** Call function components until a host element ('Card', 'View', …) is reached. */
function host(el: El): El {
  let cur = el;
  for (let i = 0; i < 10 && typeof cur.type === 'function'; i++) cur = (cur.type as (p: unknown) => El)(cur.props);
  return cur;
}
const flat = (style: unknown): Record<string, number> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : ((style as Record<string, number>) ?? {});
const kids = (el: El): El[] =>
  React.Children.toArray(el.props['children']).filter((c): c is El => React.isValidElement(c));

/** The space a block keeps above / below itself (margins add; a one-child wrapper View adds its child's). */
function edge(el: El, side: 'marginTop' | 'marginBottom'): number {
  const h = host(el);
  const own = flat(h.props['style'])[side] ?? 0;
  const inner = h.type === 'View' && kids(h).length === 1 ? edge(kids(h)[0]!, side) : 0;
  return own + inner;
}
const isCard = (el: El): boolean => {
  const h = host(el);
  return h.type === 'Card' || (h.type === 'View' && kids(h).length === 1 && isCard(kids(h)[0]!));
};
function find(el: El, type: string): El | null {
  if (el.type === type) return el;
  for (const k of kids(typeof el.type === 'function' ? host(el) : el)) {
    const f = find(k, type);
    if (f) return f;
  }
  return null;
}

describe('driver Account screen: every card has the same gap above it', () => {
  const screen = MoverAccountScreen({ navigation: { navigate: vi.fn() } }) as El;
  const stack = find(screen, 'ScrollView')!;
  const cards = kids(stack).filter(isCard);
  const label = (el: El): string => {
    const t = JSON.stringify(host(el).props, (k, v) => (k === '_owner' || k === '_store' ? undefined : v)) ?? '';
    return t.includes('Your MMG pay link') || (el.props as any).who === 'rides' ? 'MMG pay link' : t.includes('photo of your vehicle') ? 'vehicle' : t.includes('standing') ? 'standing' : String(host(el).type);
  };

  it('renders the cards the owner saw (profile, standing, vehicle, MMG pay link, ops rows, the model)', () => {
    expect(cards.length).toBeGreaterThanOrEqual(6);
    const names = cards.map(label);
    const v = names.indexOf('vehicle');
    expect(v, names.join(' | ')).toBeGreaterThan(0);
    expect(names[v + 1]).toBe('MMG pay link');
  });

  it('the vehicle card and the MMG pay link card do not touch', () => {
    const names = cards.map(label);
    const v = names.indexOf('vehicle');
    expect(edge(cards[v]!, 'marginBottom') + edge(cards[v + 1]!, 'marginTop')).toBe(space.md);
  });

  it('every pair of consecutive cards is space.md apart (none touch, none doubled)', () => {
    const gaps = cards.slice(1).map((c, i) => `${label(cards[i]!)} -> ${label(c)}: ${edge(cards[i]!, 'marginBottom') + edge(c, 'marginTop')}`);
    expect(gaps).toEqual(cards.slice(1).map((c, i) => `${label(cards[i]!)} -> ${label(c)}: ${space.md}`));
  });
});
