import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safe-return-path';
import { BYPASS_CORPUS } from '@/test/redirect-corpus';

// [WEB-GUARDS] The shared rule itself: the bypass corpus is refused (null), in-app paths come back unchanged and
// resolve on the site's own origin. Synthetic hosts only.
describe('safeInternalPath', () => {
  it.each(BYPASS_CORPUS.map((v) => [JSON.stringify(v), v]))('refuses %s', (_label, value) => {
    expect(safeInternalPath(value)).toBeNull();
  });

  it('refuses null, undefined, C1 controls and an over-long path', () => {
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
    expect(safeInternalPath('/\u0085/evil.example')).toBeNull();
    expect(safeInternalPath(`/${'a'.repeat(2048)}`)).toBeNull();
    expect(safeInternalPath('/%E0%A4%A')).toBeNull(); // a broken escape is not a path
  });

  it.each([['/'], ['/market'], ['/store/garden-kitchen?src=qr'], ['/orders/abc#top'], ['/selfie?step=2'], ['/search?q=roti%20and%20dhal']])(
    'keeps %s, which stays on the site',
    (value) => {
      expect(safeInternalPath(value)).toBe(value);
      expect(new URL(value, 'https://swiftgy.com/login').origin).toBe('https://swiftgy.com');
    },
  );
});
