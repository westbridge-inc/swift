import { Children, isValidElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ServiceWorkerRegistrar } from '@/components/service-worker-registrar';
import RootLayout, { metadata, viewport } from './layout';
import manifest from './manifest';

// The real config refuses to load while company details are placeholders; the
// layout only needs these fields from it.
vi.mock('@/site.config', () => ({
  site: { legalEntityName: 'Swift Test Ltd' },
  launch: { markets: ['Georgetown, Guyana'] },
  SITE_ORIGIN: 'https://swiftgy.com',
}));

// ---------------------------------------------------------------------------
// [PWA-1] What the root layout tells a phone about the installed app: an iOS
// home-screen app titled Swift with a solid status bar and its own icon, the
// whole screen (viewport-fit=cover) with zoom left alone, the manifest's theme
// colour, and a service worker registered on every page.
// ---------------------------------------------------------------------------

const WEB_ROOT = process.cwd();

function pngSize(publicPath: string) {
  const bytes = readFileSync(join(WEB_ROOT, 'public', publicPath));
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe('[PWA-1] root metadata for the installed app', () => {
  it('declares an iOS home-screen app titled Swift, with a solid status bar', () => {
    expect(metadata.appleWebApp).toEqual({ capable: true, title: 'Swift', statusBarStyle: 'default' });
    // Next emits only the standard name for `capable`; older iOS reads the Apple one.
    expect(metadata.other).toMatchObject({ 'apple-mobile-web-app-capable': 'yes' });
  });

  it('gives iOS a real 180×180 home-screen icon', () => {
    expect(metadata.icons).toMatchObject({
      apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    });
    expect(pngSize('apple-touch-icon.png')).toBe('180x180');
  });

  it('uses the whole screen, keeps zoom, and colours the bar like the manifest', () => {
    expect(viewport.viewportFit).toBe('cover');
    expect(viewport.themeColor).toBe(manifest().theme_color);
    expect(viewport.maximumScale).toBeUndefined();
    expect(viewport.userScalable).toBeUndefined();
  });

  it('keeps phone-number detection off', () => {
    expect(metadata.formatDetection).toMatchObject({ telephone: false });
  });

  it('registers the service worker from every page', () => {
    const html = RootLayout({ children: null }) as ReactElement<{ children: ReactElement<{ children: unknown }> }>;
    const body = html.props.children;
    const mounted = Children.toArray(body.props.children as never).some(
      (child) => isValidElement(child) && child.type === ServiceWorkerRegistrar,
    );
    expect(mounted).toBe(true);
  });

  it('pads the sides of every page clear of the notch', () => {
    const css = readFileSync(join(WEB_ROOT, 'src/app/globals.css'), 'utf8');
    const body = css.match(/\nbody\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toContain('padding-left: env(safe-area-inset-left)');
    expect(body).toContain('padding-right: env(safe-area-inset-right)');
  });
});
