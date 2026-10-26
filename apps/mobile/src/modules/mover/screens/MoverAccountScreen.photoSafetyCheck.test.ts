import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// [Row 312 · REVIEW-F S4-1 · COORD 23 Oct, rides the pre-launch OTA] While the malware scanner is down
// (the emergency bypass) a mover's vehicle photo is stored unscanned and the server withholds it until
// its rescan answers clean: vehiclePhotoUrl null, vehiclePhotoScan AWAITING (or FAILED). The mover's own
// Account screen used to say "Add photo" as if nothing had been uploaded. It now says the photo is
// waiting for its file check (REVIEW-F S3-1 on #2095: not "safety check", which means the safety check-ins), or that it did not pass and must be uploaded again.

const server = vi.hoisted(() => ({ photo: {} as Record<string, unknown>, sub: null as Record<string, unknown> | null }));

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
  IconChip: 'IconChip',
  PopupCard: 'PopupCard',
  PopupTitle: 'PopupTitle',
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
vi.mock('../DeliveriesTooCard', () => ({ DeliveriesTooCard: 'DeliveriesTooCard' })); // [CARS-DELIVER] its own test: MoverAccount.deliveriesToo
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../services/api', () => ({ driverApi: {} }));
const STANDING = { standing: 'GOOD', displayRating: 4.8, ratingBucket: '4.5+', ratingCount: 30, topRated: false, folded: { count: 0, average: null }, trend: [], topPositive: [], topNegative: [], coaching: [] };
vi.mock('../../../hooks', () => ({
  useMoverKind: () => ({
    kind: 'DRIVER',
    profile: { vehicleColor: 'Black', vehicleMake: 'Toyota', vehicleModel: 'Allion', licensePlate: 'HC1234', averageRating: 4.8, mmgPayUrl: null, ...server.photo },
  }),
  useMoverStanding: () => ({ data: STANDING }),
  useVerificationStatus: () => ({ data: { roleVerified: true } }),
  useEarningsSummary: () => ({ data: { allTime: { total: 0 } } }),
  useMoverSubscription: () => ({ data: server.sub }),
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
// [OWNER 21 Oct] The real billing blocks: their own spacing is what is measured below.
vi.mock('../../../components/billing/BillingSurfaces', async (importOriginal) => importOriginal());
vi.mock('../../../lib/billing', async (importOriginal) => ({ ...(await importOriginal<object>()), resumeBillingMethod: () => 'NONE' }));
vi.mock('../../../stores/moverPreview', () => ({ useMoverPreview: () => false }));

import { MoverAccountScreen } from './MoverAccountScreen';

type El = React.ReactElement<Record<string, any>>;
/** Every string the rendered tree shows (text children and link labels), function components expanded. */
function texts(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 60 || node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) texts(n, out, depth + 1); return out; }
  if (!React.isValidElement(node)) return out;
  const el = node as El;
  if (typeof el.type === 'function') return texts((el.type as (p: unknown) => unknown)(el.props), out, depth + 1);
  if (typeof el.props['label'] === 'string') out.push(el.props['label']);
  return texts(el.props['children'], out, depth + 1);
}
const shown = (photo: Record<string, unknown>) => {
  server.photo = photo;
  return texts(MoverAccountScreen({ navigation: { navigate: vi.fn() } }) as El).join(' | ');
};

describe('[Row 312] the mover’s own vehicle card says what happened to the photo', () => {
  it('waiting for its scan: says so, never "Add photo"', () => {
    const view = shown({ vehiclePhotoUrl: null, vehiclePhotoScan: 'AWAITING' });
    expect(view).toContain('Photo waiting for a file check. Customers see it once it clears.');
    expect(view).not.toContain('Add photo');
    expect(view).not.toContain('Add a clear photo of your vehicle');
  });
  it('failed its scan: says so and asks for a new upload', () => {
    const view = shown({ vehiclePhotoUrl: null, vehiclePhotoScan: 'FAILED' });
    expect(view).toContain('This photo didn’t pass our file check. Upload a new photo.');
    expect(view).toContain('Upload again');
    expect(view).not.toContain('Photo waiting for a file check. Customers see it once it clears.');
  });
  it('no photo (or one gone before its scan): "Add photo" as before; a shown photo: "Change photo"', () => {
    for (const photo of [{}, { vehiclePhotoUrl: null }, { vehiclePhotoUrl: null, vehiclePhotoScan: 'GONE' }]) {
      const view = shown(photo);
      expect(view, JSON.stringify(photo)).toContain('Add photo');
      expect(view).toContain('Add a clear photo of your vehicle');
      expect(view).not.toMatch(/file check/);
    }
    // A photo the server shows has passed: whatever state rides along, it is not "waiting".
    for (const photo of [{ vehiclePhotoUrl: '/uploads/vehicles/d1/car.jpg' }, { vehiclePhotoUrl: '/uploads/vehicles/d1/car.jpg', vehiclePhotoScan: 'AWAITING' }]) {
      const view = shown(photo);
      expect(view, JSON.stringify(photo)).toContain('Change photo');
      expect(view).not.toMatch(/file check|Add photo/);
    }
  });
});
