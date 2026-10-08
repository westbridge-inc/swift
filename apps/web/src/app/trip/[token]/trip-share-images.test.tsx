import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_API_ORIGIN, RELEASE_BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { TripShareClient, ownedImageSrc } from './trip-share-client';

// ---------------------------------------------------------------------------
// [M053] The public trip page carries its bearer token in the address. It
// draws only Swift's own images (https on the API's origin), never a URL a
// profile field happens to hold, sends no referrer with anything it loads,
// and the site serves the page itself with Referrer-Policy: no-referrer.
// ---------------------------------------------------------------------------

const api = new URL(BROWSER_API_ORIGIN).origin;
const IMAGE_ORIGIN = 'https://api.synthetic.invalid';
const owned = `${IMAGE_ORIGIN}/uploads/drivers/synthetic.jpg`;

function serve(photoUrl: string | null) {
  const view = {
    status: 'Trip in progress', ended: false, passengerFirstName: 'Asha',
    driver: { firstName: 'Deo', photoUrl, vehiclePhotoUrl: null, vehicle: 'Silver Toyota Allion', plate: 'PAB 1234' },
    location: null, emergencyNote: 'note',
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ success: true, data: view }) })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('[M053] only owned images, with no referrer', () => {
  it('the page judges ownership against the API origin by default', () => {
    expect(ownedImageSrc(`${api}/x.jpg`)).toBe(api.startsWith('https:') ? `${api}/x.jpg` : null);
  });

  it('accepts only https on the API origin', () => {
    const httpsApi = IMAGE_ORIGIN;
    expect(ownedImageSrc(owned, httpsApi)).toBe(owned);
    expect(ownedImageSrc('https://tracker.example/pixel.png', httpsApi)).toBeNull();
    expect(ownedImageSrc(owned.replace('https:', 'http:'), httpsApi)).toBeNull();
    expect(ownedImageSrc('/uploads/drivers/synthetic.jpg', httpsApi)).toBeNull();
    expect(ownedImageSrc('javascript:alert(1)', httpsApi)).toBeNull();
    expect(ownedImageSrc(null, httpsApi)).toBeNull();
  });

  it('a third-party photo URL is never loaded: the page shows the initial', async () => {
    serve('https://tracker.example/pixel.png');
    const { container } = render(<TripShareClient token="t-third-party" imageOrigin={IMAGE_ORIGIN} />);
    expect(await screen.findByText('PAB 1234')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('every image and frame the page draws is sent with no referrer', async () => {
    serve(owned);
    const { container } = render(<TripShareClient token="t-owned" imageOrigin={IMAGE_ORIGIN} />);
    expect(await screen.findByText('PAB 1234')).toBeTruthy();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(owned);
    for (const el of Array.from(container.querySelectorAll('img, iframe, a[href^="http"]'))) {
      expect(el.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
  });

  it('the site serves the trip and parcel pages with Referrer-Policy: no-referrer', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', RELEASE_BROWSER_API_ORIGIN);
    vi.resetModules();
    const { default: createNextConfig } = await import('../../../../next.config');
    const rules = await createNextConfig(PHASE_PRODUCTION_BUILD).headers!();
    for (const source of ['/trip/:path*', '/track/:path*']) {
      const rule = rules.find((r: { source: string }) => r.source === source);
      expect(rule, source).toBeDefined();
      expect((rule!.headers as Array<{ key: string; value: string }>).find((h) => h.key === 'Referrer-Policy')?.value).toBe('no-referrer');
    }
  });
});
