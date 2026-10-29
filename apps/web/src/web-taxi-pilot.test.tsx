import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaxiPage from './app/(app)/taxi/page';
import { HomeScreen as CustomerHomePage } from './app/(app)/home-screen';
import ExplorePage from './app/(app)/explore/page';
import WelcomePage from './app/(marketing)/welcome/page';
import FaqPage from './app/(marketing)/faq/page';
import HowItWorksPage from './app/(marketing)/how-it-works/page';
import { SiteFooter } from './components/site';
import { CustomerSessionProvider, type CustomerSession } from './components/customer-session';

vi.mock('@/site.config', () => ({
  site: { legalEntityName: 'Westbridge', supportEmail: 'support@example.test' },
  launch: { webOrdering: 'live', markets: ['Georgetown, Guyana'], verticals: {} },
  SITE_ORIGIN: 'https://swift.example',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/customer-rides', async (original) => ({
  ...(await original<typeof import('@/lib/customer-rides')>()),
  rideCapabilities: vi.fn().mockResolvedValue({ maxStops: 0 }),
  activeRide: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn().mockResolvedValue({ lat: 6.8, lng: -58.1 }) }));
vi.mock('@/lib/customer', () => ({
  activeRide: vi.fn().mockResolvedValue(null),
  getHome: vi.fn().mockResolvedValue({}), getVendors: vi.fn().mockResolvedValue([]),
  rideAvailability: vi.fn().mockResolvedValue({ level: 'GOOD' }),
  rideEstimate: vi.fn(), requestRide: vi.fn(), watchRide: vi.fn(), money: vi.fn(),
}));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(path) && !/\.test\./.test(path) ? [path] : [];
  });
}

const URLS = ['/taxi', '/taxi?pickup=6.8,-58.1&dropoff=6.9,-58.2', '/taxi?request=1&rideClass=ECONOMY'];
const asPerson = (status: 'signed-in' | 'guest'): CustomerSession => ({
  status, scope: status === 'guest' ? 'guest' : 'customer-test', epoch: 0,
  ensureSignedIn: async () => status === 'signed-in', nearPoint: null, setNearPoint: () => undefined,
});

describe('web taxi pilot restriction', () => {
  it.each(URLS)('%s offers the mobile app and no booking controls to a guest', async (url) => {
    window.history.replaceState({}, '', url);
    const { container } = render(<CustomerSessionProvider value={asPerson('guest')}><TaxiPage /></CustomerSessionProvider>);
    expect(await screen.findByText(/Taxi rides are booked in the Swift mobile app/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Swift app' }).getAttribute('href')).toBe('swift://');
    expect(container.querySelector('form, input, select, button')).toBeNull();
  });

  // [Row 117 · owner 16 Oct 2026 20:40Z] A signed-in customer may now price a
  // route (the server's fare estimate); BOOKING stays in the app. The only
  // controls are the two address boxes and their map pins — no form, no
  // select, no request button, whatever the URL carries.
  it.each(URLS)('%s offers a signed-in customer the fare boxes and the app, and no booking controls', async (url) => {
    window.history.replaceState({}, '', url);
    const { container } = render(<CustomerSessionProvider value={asPerson('signed-in')}><TaxiPage /></CustomerSessionProvider>);
    expect(await screen.findByText(/Taxi rides are booked in the Swift mobile app/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Swift app' }).getAttribute('href')).toBe('swift://');
    expect(container.querySelector('form, select')).toBeNull();
    expect([...container.querySelectorAll('input')].map((input) => input.placeholder)).toEqual(['Search address…', 'Search address…']);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Pin pickup on the map', 'Pin destination on the map']);
  });

  it('uses the mobile app’s registered scheme, without inventing a taxi route or store URL', () => {
    const config = readFileSync(join(process.cwd(), '../mobile/app.config.ts'), 'utf8');
    expect(config).toMatch(/scheme: 'swift'/);
  });

  // [Row 117 · owner 16 Oct 2026 20:40Z] Web booking is BUILT behind the
  // server switch WEB_TAXI_BOOKING (off): ONE wrapper, ONE caller, no queue
  // call and no proxy. The caller renders only while the server says
  // webBooking (taxi-booking.test.tsx), and the server refuses every browser
  // ride request while the switch is off, whatever this code does.
  it('has exactly one ride-creation wrapper and one caller, and no queue call or proxy anywhere in web source', () => {
    const root = join(process.cwd(), 'src');
    const mentions = (pattern: RegExp) => sources(root)
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(root.length + 1).split(sep).join('/'))
      .sort();
    expect(mentions(/\brequestRide\b|\/rides\/request\b/)).toEqual(['app/(app)/taxi/taxi-booking.tsx', 'lib/customer-rides.ts']);
    expect(mentions(/\bcreateRideRequest\b|\/rides\/queue\/join/)).toEqual([]);
    const wrapper = readFileSync(join(root, 'lib/customer-rides.ts'), 'utf8');
    expect(wrapper.match(/\/api\/v1\/rides\/request/g)).toHaveLength(1);
  });

  it('marks both customer taxi entry tiles as mobile-only', () => {
    // [Q7b] The customer home's tiles moved with it: the home is `/` and its
    // service grid lives in components/customer-home.tsx.
    for (const file of ['src/components/customer-home.tsx', 'src/app/(app)/explore/page.tsx']) {
      const code = readFileSync(join(process.cwd(), file), 'utf8');
      expect(code).toMatch(/href: '\/taxi'.*Swift mobile app/);
    }
  });

  // The customer home reads its stores through React Query, which the app
  // shell provides; here it gets its own client.
  function CustomerHome() {
    return (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CustomerHomePage />
      </QueryClientProvider>
    );
  }

  it.each([
    ['customer home', CustomerHome], ['explore', ExplorePage],
    ['welcome', WelcomePage], ['FAQ', FaqPage], ['how it works', HowItWorksPage], ['footer', SiteFooter],
  ] as const)('%s states that taxi rides require the mobile app', (_name, Page) => {
    render(<Page />);
    expect(screen.getAllByText(/taxi rides.*Swift mobile app/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/everything works, including tracking/)).toBeNull();
    expect(screen.queryByText(/No app needed|Everything the Swift app does, now on the web/)).toBeNull();
  });
});
