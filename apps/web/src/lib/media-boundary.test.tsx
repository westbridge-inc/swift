import { render } from '@testing-library/react';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { ImageConfigContext } from 'next/dist/shared/lib/image-config-context.shared-runtime';
import { imageConfigDefault } from 'next/dist/shared/lib/image-config';
import { hasLocalMatch } from 'next/dist/shared/lib/match-local-pattern';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Photo } from '@/components/order-ui';
import { photo } from './media';
import { MEDIA_DEVICE_SIZES, MEDIA_IMAGE_SIZES } from './media-patterns';
import { RELEASE_BROWSER_API_ORIGIN } from './browser-api-origin';

afterAll(() => vi.unstubAllEnvs());

describe('store-photo resize boundary', () => {
  it('the built-in optimiser cannot wrap /media and restore its stale-on-error cache', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', RELEASE_BROWSER_API_ORIGIN);
    vi.stubEnv('SWIFT_WEB_CHANNEL', 'production');
    vi.resetModules();
    const { default: configure } = await import('../../next.config');
    const patterns = configure(PHASE_PRODUCTION_BUILD).images?.localPatterns;
    expect(hasLocalMatch(patterns, '/media/items/store/AbCdEfGh_jKlMn-p.jpg?w=160')).toBe(false);
    expect(hasLocalMatch(patterns, '/media/uploads/items/store/AbCdEfGh_jKlMn-p.jpg?w=160')).toBe(false);
    expect(hasLocalMatch(patterns, '/icons/icon-192.png')).toBe(true);
    expect(hasLocalMatch(patterns, '/_next/static/media/image.hash.png')).toBe(true);
  });

  it.each(['\n', '\r', '\t'])('refuses a source that URL parsing would silently normalize (%j)', (control) => {
    expect(photo(`https://api.example.test/items/store/${control}AbCdEfGh_jKlMn-p.jpg`, 'https://api.example.test')?.unoptimized).toBe(true);
  });

  it.each(['64px', '160px', '(min-width: 760px) 1200px, 100vw'])('keeps responsive dimensions and permitted widths for %s', (sizes) => {
    const { container } = render(
      <ImageConfigContext.Provider value={{ ...imageConfigDefault, deviceSizes: MEDIA_DEVICE_SIZES, imageSizes: MEDIA_IMAGE_SIZES }}>
        <Photo src="items/store/AbCdEfGh_jKlMn-p.jpg" alt="Store photo" sizes={sizes} priority />
      </ImageConfigContext.Provider>,
    );
    const img = container.querySelector('img')!;
    const srcset = img.getAttribute('srcset')!;
    expect(srcset).not.toContain('/_next/image');
    expect(img.getAttribute('sizes')).toBe(sizes);
    expect(img.getAttribute('loading')).not.toBe('lazy');
    const widths = [...srcset.matchAll(/\?w=(\d+)/g)].map((match) => Number(match[1]));
    expect(widths.length).toBeGreaterThan(1);
    for (const width of widths) expect([...MEDIA_DEVICE_SIZES, ...MEDIA_IMAGE_SIZES]).toContain(width);
    expect(img.style.position).toBe('absolute');
  });
});
