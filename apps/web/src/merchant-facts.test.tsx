import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { site } from '@/site.config';

// ---------------------------------------------------------------------------
// [Q36] The card bank's minimum website information. The bank is sent a
// screenshot of each item and may visit the site, so each one is checked on
// the rendered route, with its real chrome and the REAL company facts — never
// a mock of site.config. A route this file needs that does not exist yet fails
// as an assertion that names the route.
// ---------------------------------------------------------------------------

const APP = join(process.cwd(), 'src', 'app');

/** Every page file in the app, by the URL it serves (route groups are folders only). */
function pagesByUrl(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^page\.(tsx|ts)$/.test(entry.name)) {
        const segments = relative(APP, directory).split(sep).filter((s) => s && !/^\(.*\)$/.test(s));
        found.set(`/${segments.join('/')}`, path);
      }
    }
  };
  walk(APP);
  return found;
}

const LAYOUT_OF: Record<string, string> = {
  '/about': '(marketing)/layout.tsx',
  '/contact': '(marketing)/layout.tsx',
  '/legal/refunds': 'legal/layout.tsx',
  '/legal/delivery': 'legal/layout.tsx',
};

/** Renders a route the way Next does: its layout around its page. */
async function renderRoute(url: keyof typeof LAYOUT_OF) {
  const file = pagesByUrl().get(url);
  expect(file, `${url} has no page`).toBeTruthy();
  const layoutFile = join(APP, LAYOUT_OF[url]!);
  expect(existsSync(layoutFile), `${url} has no layout at ${LAYOUT_OF[url]}`).toBe(true);
  const { default: Page } = (await import(/* @vite-ignore */ file!)) as { default: () => unknown };
  const { default: Layout } = (await import(/* @vite-ignore */ layoutFile)) as { default: (p: { children: React.ReactNode }) => React.ReactNode };
  const content = (await Page()) as React.ReactNode;
  return render(<Layout>{content}</Layout>);
}

const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';
const footer = () => screen.getByRole('contentinfo');

describe('[Q36] the minimum website information the card bank requires', () => {
  it('1 · the business trade name, and the company that operates it', async () => {
    await renderRoute('/about');
    const facts = screen.getByRole('region', { name: 'Company facts' });
    expect(facts.textContent).toContain(site.tradeName);
    expect(facts.textContent).toContain(site.tradeNameAlt);
    expect(facts.textContent).toContain(site.legalEntityName);
    expect(footer().textContent).toContain(`${site.tradeName} is a trade name of ${site.legalEntityName}`);
  });

  it('2 · a complete description of the goods and services, including what Swift charges', async () => {
    await renderRoute('/about');
    const services = screen.getByRole('region', { name: 'What Swift does' });
    const words = services.textContent ?? '';
    for (const who of ['Customers', 'Businesses', 'Delivery riders', 'Taxi drivers']) expect(words, who).toContain(who);
    expect(words).toMatch(/weekly fee/i);
    expect(within(services).getByRole('link', { name: /pricing/i }).getAttribute('href')).toBe('/pricing');
  });

  it('3 · the return, refund and cancellation policy', async () => {
    await renderRoute('/legal/refunds');
    expect(screen.getByRole('heading', { level: 1, name: 'Refunds and cancellations' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /cancelling an order/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /weekly partner fee/i })).toBeTruthy();
  });

  it('4 · customer service contact: e-mail address and telephone number', async () => {
    await renderRoute('/contact');
    expect(screen.getAllByRole('link', { name: site.supportEmail })[0]!.getAttribute('href')).toBe(`mailto:${site.supportEmail}`);
    expect(screen.getAllByRole('link', { name: site.phone })[0]!.getAttribute('href')).toBe(`tel:${site.phone.replace(/[^\d+]/g, '')}`);
    cleanup();
    await renderRoute('/legal/refunds');
    expect(screen.getAllByRole('link', { name: site.supportEmail }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: site.phone }).length).toBeGreaterThan(0);
  });

  it('5 · the domicile country and the transaction currency (Guyana, GYD)', async () => {
    await renderRoute('/about');
    const facts = screen.getByRole('region', { name: 'Company facts' }).textContent ?? '';
    expect(facts).toContain(`Domicile country${site.country}`);
    expect(facts).toContain(`Transaction currency${site.currencyName} (${site.currencyCode})`);
    expect(footer().textContent).toContain(`Prices in ${site.currencyCode}`);
  });

  it('6 · export restrictions', async () => {
    await renderRoute('/about');
    expect(screen.getByRole('region', { name: 'Company facts' }).textContent).toContain(`only in ${site.country} and does not export goods`);
  });

  it('7 · the delivery policy', async () => {
    await renderRoute('/legal/delivery');
    expect(screen.getByRole('heading', { level: 1, name: 'Delivery policy' })).toBeTruthy();
    expect(text()).toContain(`No deliveries outside ${site.country}`);
    expect(screen.getByRole('heading', { name: /pickup/i })).toBeTruthy();
  });

  it('8 · the country in which the merchant is officially registered and located (Georgetown, Guyana)', async () => {
    await renderRoute('/about');
    expect(screen.getByRole('region', { name: 'Company facts' }).textContent).toContain(`Registered and located in${site.registeredCity}, ${site.country}`);
  });

  // The official artwork is gated behind the brands' own terms, which only the
  // company can accept; until it is supplied the footer names both cards in
  // plain text (never an imitation of a mark).
  it('9 · Visa and Mastercard are named under Payment methods, beside cash and MMG', async () => {
    await renderRoute('/about');
    const methods = within(footer()).getByRole('region', { name: 'Payment methods' });
    const listed = within(methods).getAllByRole('listitem').map((item) => item.textContent ?? '');
    for (const method of ['Cash', 'MMG', 'Visa', 'Mastercard']) expect(listed.some((item) => item.startsWith(method)), method).toBe(true);
  });
});

describe('[Q36] the footer reaches every policy page, and every footer link resolves', () => {
  it.each(['/about', '/legal/refunds'] as const)('on %s: Terms, Privacy, Refunds and cancellations, Delivery policy and Contact', async (url) => {
    await renderRoute(url);
    const hrefs = within(footer()).getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
    for (const required of ['/legal/terms', '/legal/privacy', '/legal/refunds', '/legal/delivery', '/contact']) {
      expect(hrefs, required).toContain(required);
    }
    const pages = pagesByUrl();
    for (const href of hrefs.filter((h) => h.startsWith('/'))) {
      expect(pages.has(href.split(/[?#]/)[0]!), `footer link ${href} has no page`).toBe(true);
    }
  });
});
