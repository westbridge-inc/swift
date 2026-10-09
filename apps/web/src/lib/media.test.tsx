import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RELEASE_BROWSER_API_ORIGIN, STAGING_BROWSER_API_ORIGIN } from './browser-api-origin';
import { mediaUrl, optimizable, photo } from './media';
import { Photo } from '@/components/order-ui';

// ---------------------------------------------------------------------------
// [W2b · owner ruling h4: resize on the web server] Stores' photos are saved
// by the API as a path. The website must put the API's origin in front (as the
// phone app does), and hand the API's public photos — and only those — to the
// web server's image optimiser, which sizes them for the screen.
// ---------------------------------------------------------------------------

const API = 'https://api.example.test';

describe('[W2b] where a stored photo lives', () => {
  it('puts the API origin in front of a stored path, as the phone app does', () => {
    expect(mediaUrl('/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg', API)).toBe(`${API}/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg`);
    expect(mediaUrl('uploads/items/v1/AbCdEfGh_jKlMn-p.jpg', API)).toBe(`${API}/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg`);
    expect(mediaUrl(`${API}/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg`, API)).toBe(`${API}/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg`);
    expect(mediaUrl('https://elsewhere.test/a.jpg', API)).toBe('https://elsewhere.test/a.jpg');
    expect(mediaUrl('blob:https://swiftgy.com/123', API)).toBe('blob:https://swiftgy.com/123');
    expect(mediaUrl(null, API)).toBeNull();
    expect(mediaUrl('', API)).toBeNull();
  });

  it('only avatars and vehicles use the built-in optimiser', () => {
    expect(optimizable(`${API}/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg`, API)).toBe(false);
    expect(optimizable(`${API}/uploads/avatars/u1.jpg`, API)).toBe(true);
    expect(optimizable(`${API}/uploads/vehicles/d1.jpg`, API)).toBe(true);
    // Never another host, a private folder, or a path that climbs out.
    expect(optimizable('https://elsewhere.test/uploads/items/a.jpg', API)).toBe(false);
    expect(optimizable(`${API}/uploads/verification/u1/id.jpg`, API)).toBe(false);
    expect(optimizable(`${API}/uploads/items/../verification/id.jpg`, API)).toBe(false);
    expect(optimizable(`${API}/uploads/items/%2e%2e/verification/id.jpg`, API)).toBe(false);
    expect(optimizable(`http://api.example.test/uploads/items/a.jpg`, API)).toBe(false);
    expect(photo('/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg', API)).toEqual({ src: '/media/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg', unoptimized: false, loader: expect.any(Function) });
    expect(photo('https://elsewhere.test/a.jpg', API)).toEqual({ src: 'https://elsewhere.test/a.jpg', unoptimized: true });
  });

  it('a store photo kept in object storage (saved as "items/<store>/<file>") bypasses the optimiser — that address only', () => {
    const key = 'items/cm1store0000000000000001/AbCdEfGh_jKlMn-p.jpg';
    expect(mediaUrl(key, API)).toBe(`${API}/${key}`);
    expect(photo(key, API)).toEqual({ src: `/media/${key}`, unoptimized: false, loader: expect.any(Function) });
    expect(optimizable(`${API}/${key}`, API)).toBe(false);
    // A store, then a photo: nothing deeper or shallower, no other folder, no climbing.
    expect(optimizable(`${API}/items/cm1store/sub/AbCdEfGh_jKlMn-p.jpg`, API)).toBe(false);
    expect(optimizable(`${API}/items/AbCdEfGh_jKlMn-p.jpg`, API)).toBe(false);
    expect(optimizable(`${API}/verification/u1/AbCdEfGh_jKlMn-p.jpg`, API)).toBe(false);
    expect(optimizable(`${API}/items/cm1store/..%2F..%2Fverification%2Fid.jpg`, API)).toBe(false);
    expect(optimizable(`${API}/items/../verification/u1/AbCdEfGh_jKlMn-p.jpg`, API)).toBe(false);
    expect(optimizable(`https://elsewhere.test/${key}`, API)).toBe(false);
  });

  it('a store’s photo card asks the web server for a resized copy of the API’s photo, sized for the card', () => {
    // The test origin (vitest.config) is the browser API origin here.
    const { container } = render(<Photo src="/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg" name="Cook-up rice" sizes="160px" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/^\/media\/uploads\/items\/v1\/AbCdEfGh_jKlMn-p\.jpg\?w=\d+$/);
    expect(img.getAttribute('srcset')).toContain('/media/uploads/items/v1/AbCdEfGh_jKlMn-p.jpg?w=');
    expect(img.getAttribute('srcset')).not.toContain('/_next/image');
    expect(img.getAttribute('sizes')).toBe('160px');
  });

  it('a store photo saved as an object-storage key is resized by the web server like any other', () => {
    const { container } = render(<Photo src="items/cm1store/AbCdEfGh_jKlMn-p.jpg" name="Pepperpot" sizes="160px" />);
    expect(container.querySelector('img')!.getAttribute('src')).toMatch(/^\/media\/items\/cm1store\/AbCdEfGh_jKlMn-p\.jpg\?w=\d+$/);
  });

  it('passes the custom loader and responsive widths through every store Photo card', () => {
    const media = photo(`${API}/items/store/AbCdEfGh_jKlMn-p.jpg`, API)!;
    expect(media.loader!({ src: media.src, width: 640, quality: 1 })).toBe('/media/items/store/AbCdEfGh_jKlMn-p.jpg?w=640');
    expect(photo(`${API}/uploads/avatars/u1.jpg`, API)).toEqual({ src: `${API}/uploads/avatars/u1.jpg`, unoptimized: false });
  });

  it.each([
    '/uploads/items/store/sub/AbCdEfGh_jKlMn-p.jpg',
    '/uploads/items/store/a.jpg',
    '/items/store/AbCdEfGh_jKlMn-p.jpg?token=x',
    '/items/store/AbCdEfGh_jKlMn-p.jpg#x',
    '/items/store/%41bCdEfGh_jKlMn-p.jpg',
    '/items/../store/AbCdEfGh_jKlMn-p.jpg',
    'https://user@api.example.test/items/store/AbCdEfGh_jKlMn-p.jpg',
    'https://elsewhere.test/items/store/AbCdEfGh_jKlMn-p.jpg',
  ])('never hands an invalid store source to either resize route: %s', (source) => {
    expect(photo(source, API)?.unoptimized).toBe(true);
    expect(photo(source, API)?.loader).toBeUndefined();
  });

  it('a photo on any other host is drawn as it is, never through the optimiser', () => {
    const { container } = render(<Photo src="https://elsewhere.test/a.jpg" name="Elsewhere" sizes="160px" />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('https://elsewhere.test/a.jpg');
  });
});

describe('[W2b] the web server’s image optimiser', () => {
  async function releaseConfig(origin: string, channel: string): Promise<NextConfig> {
    vi.stubEnv('NEXT_PUBLIC_API_URL', origin);
    vi.stubEnv('SWIFT_WEB_CHANNEL', channel);
    vi.stubEnv('SWIFT_WEB_IMAGE_BUILD', '0');
    vi.resetModules();
    const { default: createNextConfig } = await import('../../next.config');
    return createNextConfig(PHASE_PRODUCTION_BUILD);
  }
  let release: NextConfig;
  let staging: NextConfig;
  beforeAll(async () => {
    release = await releaseConfig(RELEASE_BROWSER_API_ORIGIN, 'production');
    staging = await releaseConfig(STAGING_BROWSER_API_ORIGIN, 'staging');
  });
  afterAll(() => vi.unstubAllEnvs());

  it('may fetch only the public photo folders on the release’s own API origin', () => {
    const host = new URL(RELEASE_BROWSER_API_ORIGIN).hostname;
    expect(release.images?.remotePatterns).toEqual([
      ...['avatars', 'vehicles'].map((folder) => ({ protocol: 'https', hostname: host, port: '', pathname: `/uploads/${folder}/**` })),
    ]);
    expect(staging.images?.remotePatterns?.map((pattern) => (pattern as { hostname: string }).hostname))
      .toEqual(Array(2).fill(new URL(STAGING_BROWSER_API_ORIGIN).hostname));
    for (const pattern of release.images?.remotePatterns ?? []) {
      expect(JSON.stringify(pattern)).not.toMatch(/\*\*?\./);
    }
    expect(release.images?.domains ?? []).toEqual([]);
  });

  it('serves WebP, keeps avatar and vehicle resized copies a year, never resizes SVG', () => {
    expect(release.images?.formats).toEqual(['image/webp']);
    expect(release.images?.minimumCacheTTL).toBe(60 * 60 * 24 * 365);
    expect(release.images?.dangerouslyAllowSVG).toBe(false);
    expect(release.images?.unoptimized).toBeUndefined();
  });

  it('no stored photo is drawn unresized by hand: the only fixed `unoptimized` left is the camera preview (a local blob)', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) files.push(path);
      }
    };
    walk(root);
    // A bare `unoptimized` attribute (or `={true}`) — not the computed one from photo().
    const fixed = files.filter((file) => /\sunoptimized(?:[\s/>]|=\{\s*true\s*\})/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(root.length + 1));
    expect(fixed).toEqual(['app/selfie/page.tsx']);
  });
});
