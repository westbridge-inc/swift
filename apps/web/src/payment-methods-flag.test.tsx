import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchState } from '@/site.config';

const REFUNDS_PAGE = join(process.cwd(), 'src', 'app', 'legal', 'refunds', 'page.tsx');

// ---------------------------------------------------------------------------
// [Q36 item 9] The card methods follow launch.cardPayments, never literal text.
// Until the card rail is live, Visa and Mastercard are not shown at all: the
// partner checkout census (apps/mobile/src/__tests__/weekly-fee-census.test.ts)
// forbids teasing a payment method that does not exist yet, so there is no
// "coming soon" anywhere. The moment the flag says live, both cards appear in
// every footer and the refunds page says the weekly fee can be paid by card.
// The real footer and the real refunds page are loaded under each flag value.
// ---------------------------------------------------------------------------

async function withCards(cardPayments: LaunchState) {
  vi.resetModules();
  vi.doMock('@/site.config', async () => {
    const real = await vi.importActual<typeof import('@/site.config')>('@/site.config');
    return { ...real, launch: { ...real.launch, cardPayments } };
  });
  const { SiteFooter } = await import('@/components/site');
  const refundsPage = async () => {
    expect(existsSync(REFUNDS_PAGE), '/legal/refunds has no page').toBe(true);
    return ((await import(/* @vite-ignore */ REFUNDS_PAGE)) as { default: () => React.ReactNode }).default;
  };
  return { SiteFooter, refundsPage };
}

const cardItems = () => within(screen.getByRole('region', { name: 'Payment methods' }))
  .getAllByRole('listitem')
  .filter((item) => /^(Visa|Mastercard)/.test(item.textContent ?? ''));

afterEach(() => vi.doUnmock('@/site.config'));

describe('[Q36] the card methods follow launch.cardPayments', () => {
  it('until the card rail is live, no card is listed or teased: the footer shows cash and MMG only', async () => {
    const { SiteFooter } = await withCards('soon');
    render(<SiteFooter />);
    const region = screen.getByRole('region', { name: 'Payment methods' });
    expect(within(region).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Cash', 'MMG']);
    expect(region.textContent).toContain('Orders are paid to the business itself, in cash or by MMG.');
    expect(region.textContent).not.toMatch(/visa|mastercard|card|soon/i);
  });

  it('the moment the flag says live, Visa and Mastercard are listed, for Swift\'s own charges', async () => {
    const { SiteFooter } = await withCards('live');
    render(<SiteFooter />);
    expect(cardItems().map((item) => item.textContent)).toEqual(['Visa', 'Mastercard']);
    expect(screen.getByRole('region', { name: 'Payment methods' }).textContent)
      .toContain("Visa and Mastercard are for Swift's own charges, the weekly partner fee and advertising.");
  });

  it('the refunds page mentions cards only once they are live', async () => {
    const live = await (await withCards('live')).refundsPage();
    const view = render(<>{live()}</>);
    expect(view.container.textContent).toContain('It can also be paid by Visa or Mastercard');
    view.unmount();
    const soon = await (await withCards('soon')).refundsPage();
    render(<>{soon()}</>);
    expect(document.body.textContent).toContain('Today the fee is paid by MMG.');
    expect(document.body.textContent).not.toMatch(/visa|mastercard|coming soon/i);
  });
});
