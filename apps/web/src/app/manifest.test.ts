import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { color } from '../../../../packages/ui/src';
import { appChrome } from '@/lib/design-tokens';
import manifest from './manifest';

// The real config refuses to load while company details are placeholders; the
// manifest only needs the market.
vi.mock('@/site.config', () => ({ launch: { markets: ['Georgetown, Guyana'] } }));

// ---------------------------------------------------------------------------
// [PWA-1] The web app manifest makes Swift installable. Chrome only offers the
// install when the name, a standalone display, a start URL inside the scope and
// real 192/512 icons are all present — so each is asserted against the file
// system, not just the JSON: an icon the manifest names but the site does not
// serve fails the install as surely as a missing one.
// ---------------------------------------------------------------------------

const WEB_ROOT = process.cwd();
const SITE = 'https://swiftgy.com';

/** Width, height and colour type, straight from a PNG's IHDR chunk. */
function pngHeader(publicPath: string) {
  const bytes = readFileSync(join(WEB_ROOT, 'public', publicPath));
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { size: `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, colourType: bytes[25] };
}

describe('[PWA-1] the web app manifest', () => {
  const app = manifest();

  it('names the app Swift and opens it standalone, in portrait', () => {
    expect(app.name).toBe('Swift');
    expect(app.short_name).toBe('Swift');
    expect(app.display).toBe('standalone');
    expect(app.orientation).toBe('portrait');
    expect(app.description).toContain('Georgetown, Guyana');
  });

  it('starts at the customer home, inside its scope, under a stable id', () => {
    const start = new URL(app.start_url!, SITE);
    // [Q7b] Home is `/`: the site, and the installed app, open on ordering.
    expect(start.pathname).toBe('/');
    expect(start.searchParams.get('source')).toBe('pwa');
    expect(app.scope).toBe('/');
    expect(start.pathname.startsWith(new URL(app.scope!, SITE).pathname)).toBe(true);
    // The id is the first install's start page, pinned: moving Home to `/`
    // must not turn one installed app into two.
    expect(app.id).toBe('/order');
    // The start page is a real route of the customer app, not a guess — and
    // the first installs' start page still resolves (it redirects to /).
    expect(existsSync(join(WEB_ROOT, 'src/app/(app)/page.tsx'))).toBe(true);
    expect(existsSync(join(WEB_ROOT, 'src/app/(app)/order/page.tsx'))).toBe(true);
  });

  it('takes its colours from the design tokens', () => {
    expect(app.theme_color).toBe(appChrome.theme);
    expect(app.background_color).toBe(appChrome.background);
    expect(appChrome).toEqual({ theme: color.surface.base, background: color.surface.subtle });
  });

  it('ships a 192 and a 512 icon plus a 512 maskable, each a real opaque PNG of the size it claims', () => {
    const icons = app.icons ?? [];
    expect(icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      const header = pngHeader(icon.src);
      expect(header.size, icon.src).toBe(icon.sizes);
      // Colour type 2 is RGB with no alpha: a launcher's mask never shows a
      // transparent (black) corner.
      expect(header.colourType, icon.src).toBe(2);
    }
  });
});
