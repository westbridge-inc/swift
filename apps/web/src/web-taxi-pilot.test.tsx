import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaxiPage from './app/(app)/taxi/page';
import CustomerHomePage from './app/(app)/page';
import ExplorePage from './app/(app)/explore/page';
import WelcomePage from './app/(marketing)/welcome/page';
import FaqPage from './app/(marketing)/faq/page';
import HowItWorksPage from './app/(marketing)/how-it-works/page';
import { SiteFooter } from './components/site';

vi.mock('@/site.config', () => ({
  site: { legalEntityName: 'Westbridge', supportEmail: 'support@example.test' },
  launch: { webOrdering: 'live', markets: ['Georgetown, Guyana'], verticals: {} },
  showAppStoreBadges: false,
  SITE_ORIGIN: 'https://swift.example',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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

describe('web taxi pilot restriction', () => {
  it.each(['/taxi', '/taxi?pickup=6.8,-58.1&dropoff=6.9,-58.2', '/taxi?request=1&rideClass=ECONOMY'])(
    '%s offers the mobile app and no booking controls', async (url) => {
      window.history.replaceState({}, '', url);
      const { container } = render(<TaxiPage />);
      expect(await screen.findByText(/Taxi rides are booked in the Swift mobile app/)).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Open Swift app' }).getAttribute('href')).toBe('swift://');
      expect(container.querySelector('form, input, select, button')).toBeNull();
    },
  );

  it('uses the mobile app’s registered scheme, without inventing a taxi route or store URL', () => {
    const config = readFileSync(join(process.cwd(), '../mobile/app.config.ts'), 'utf8');
    expect(config).toMatch(/scheme: 'swift'/);
  });

  it('has no ride-creation wrapper, caller or proxy anywhere in web source', () => {
    const offenders = sources(join(process.cwd(), 'src')).filter((path) => {
      const code = readFileSync(path, 'utf8');
      return /\brequestRide\b|\bcreateRideRequest\b|\/rides\/(?:request|queue\/join)/.test(code);
    });
    expect(offenders).toEqual([]);
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
