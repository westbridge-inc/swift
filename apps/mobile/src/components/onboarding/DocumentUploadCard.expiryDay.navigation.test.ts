/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · admin #2155 gyDate rule] The expiry a person at Swift keys from the document is a calendar day: the
// console sends `new Date('2031-06-30').toISOString()`, so the API stores 2031-06-30T00:00:00.000Z. The card printed
// it with toLocaleDateString in the PHONE's zone, and in Guyana (UTC-4) midnight UTC is 20:00 the evening before:
// "Approved — valid until 29 Jun 2031" for a licence that says 30 June. The card now prints the stored day, the same
// rule as the admin console (gyDate: a UTC-midnight value is the stored day; any other value is a moment, printed
// as its Guyana day). Pinned in three phone zones, with the zone switched BEFORE the card is imported.
// ---------------------------------------------------------------------------

const ZONE_BEFORE = process.env['TZ'];
process.env['TZ'] = 'America/Guyana';

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  const Pressable = ({ children }: any) => R.createElement('div', { role: 'button' }, typeof children === 'function' ? children({ pressed: false }) : children);
  return { View, Pressable, ActivityIndicator: () => null, Alert: { alert: vi.fn() }, Linking: { openSettings: vi.fn() } };
});
vi.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestCameraPermissionsAsync: vi.fn(), requestMediaLibraryPermissionsAsync: vi.fn(), launchCameraAsync: vi.fn(), launchImageLibraryAsync: vi.fn(),
}));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return {
    Badge: () => null, Card: Box, T: ({ children }: any) => R.createElement('span', null, children),
    BrandCheckbox: () => null, LinkText: ({ label }: { label: string }) => R.createElement('a', null, label),
  };
});
vi.mock('../../hooks/verification', () => ({
  useUploadDocument: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, variables: undefined }),
  useWithdrawPoliceClearance: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}));
vi.mock('../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => ({ userId: 'u1' }),
  requireAuthSessionForPrincipal: (s: unknown) => s,
}));

const React = await import('react');
const { act } = React;
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
const { createRoot } = await import('react-dom/client');
const { DocumentUploadCard } = await import('./DocumentUploadCard');

let host: HTMLDivElement | null = null;
let root: { render: (n: unknown) => void; unmount: () => void } | null = null;
const caption = async (expiresAt: string, zone: string): Promise<string> => {
  process.env['TZ'] = zone;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(React.createElement(DocumentUploadCard, { role: 'MOVER', docType: 'drivers_licence', status: 'APPROVED', expiresAt, consented: true } as any)));
  return host.textContent ?? '';
};
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); host = null; root = null;
  process.env['TZ'] = 'America/Guyana';
});
process.on('exit', () => { process.env['TZ'] = ZONE_BEFORE; });

describe('[FOLLOWUPS] the card prints the expiry day the document says, in every phone zone', () => {
  // Far enough ahead that the card is APPROVED, not "Expires in N days".
  const KEYED = '2031-06-30T00:00:00.000Z';

  it('Guyana (UTC-4): the keyed 30 June is 30 June, never 29 June', async () => {
    const text = await caption(KEYED, 'America/Guyana');
    expect(text).toContain('Approved — valid until 30 Jun 2031');
    expect(text).not.toContain('29 Jun');
  });

  it('Honolulu (UTC-10) and Tokyo (UTC+9): the same day', async () => {
    expect(await caption(KEYED, 'Pacific/Honolulu')).toContain('valid until 30 Jun 2031');
    await act(async () => root!.unmount()); host!.remove(); root = null;
    expect(await caption(KEYED, 'Asia/Tokyo')).toContain('valid until 30 Jun 2031');
  });

  it('a value that is a moment (not UTC midnight) prints its Guyana day, whatever the phone zone (admin gyDate rule)', async () => {
    // 02:30 UTC on 1 Jul is 22:30 on 30 Jun in Guyana.
    expect(await caption('2031-07-01T02:30:00.000Z', 'Asia/Tokyo')).toContain('valid until 30 Jun 2031');
  });
});
