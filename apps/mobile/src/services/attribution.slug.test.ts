import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-native-mmkv', () => ({ MMKV: class { getBoolean() { return false; } getString() { return undefined; } set() {} } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'install-1' }));
vi.mock('./api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../navigation/navigationRef', () => ({ safeNavigate: vi.fn() }));

describe('first-launch store destination', () => {
  it('reads a store address with capitals or an underscore (the server mints name + nanoid)', async () => {
    const { storeSlugFromPath } = await import('./attribution');
    expect(storeSlugFromPath('/store/green-bowl-MSFa7a')).toBe('green-bowl-MSFa7a');
    expect(storeSlugFromPath('/store/sample-kitchen-aaKL9_')).toBe('sample-kitchen-aaKL9_');
  });
  it('refuses anything else', async () => {
    const { storeSlugFromPath } = await import('./attribution');
    for (const p of ['/store/a/b', '/store/../x', '/store/bad.slug', '/stores/x', '/store/-x']) expect(storeSlugFromPath(p)).toBeNull();
  });
});
