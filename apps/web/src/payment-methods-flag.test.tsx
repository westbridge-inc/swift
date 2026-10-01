import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchState } from '@/site.config';
import { SiteFooter } from '@/components/site';
import RefundsPage from '@/app/legal/refunds/page';

// ---------------------------------------------------------------------------
// [Q36 item 9] The card methods follow launch.cardPayments, never literal text.
// Until the card rail is live, Visa and Mastercard are not shown at all: the
// partner checkout census (apps/mobile/src/__tests__/weekly-fee-census.test.ts)
// forbids teasing a payment method that does not exist yet, so there is no
// "coming soon" anywhere. The moment the flag says live, both cards appear in
// every footer and the refunds page says the weekly fee can be paid by card.
//
// The real config is mocked ONCE, with cardPayments behind a getter that each
// test sets: the footer and the refunds page read the flag while rendering, so
// no module is re-imported between states (re-importing under vi.doMock after
// vi.resetModules was flaky, about 1 run in 10).
// ---------------------------------------------------------------------------

const flag = vi.hoisted(() => ({ cardPayments: 'soon' as 'live' | 'waitlist' | 'soon' }));

vi.mock('@/site.config', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/site.config')>();
  const launch = { ...real.launch };
  Object.defineProperty(launch, 'cardPayments', { get: () => flag.cardPayments, enumerable: true });
  return { ...real, launch };
});

function withCards(state: LaunchState) {
  flag.cardPayments = state;
}

const cardItems = () => within(screen.getByRole('region', { name: 'Payment methods' }))
  .getAllByRole('listitem')
  .filter((item) => /^(Visa|Mastercard)/.test(item.textContent ?? ''));

afterEach(() => withCards('soon'));

describe('[Q36] the card methods follow launch.cardPayments', () => {
  it('until the card rail is live, no card is listed or teased: the footer shows cash and MMG only', () => {
    withCards('soon');
    render(<SiteFooter />);
    const region = screen.getByRole('region', { name: 'Payment methods' });
    expect(within(region).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Cash', 'MMG']);
    expect(region.textContent).toContain('Orders are paid to the business itself, in cash or by MMG.');
    expect(region.textContent).not.toMatch(/visa|mastercard|card|soon/i);
  });

  it('the moment the flag says live, Visa and Mastercard are listed, for Swift\'s own charges', () => {
    withCards('live');
    render(<SiteFooter />);
    expect(cardItems().map((item) => item.textContent)).toEqual(['Visa', 'Mastercard']);
    expect(screen.getByRole('region', { name: 'Payment methods' }).textContent)
      .toContain("Visa and Mastercard are for Swift's own charges, the weekly partner fee and advertising.");
  });

  it('the refunds page mentions cards only once they are live', () => {
    withCards('live');
    const view = render(<RefundsPage />);
    expect(view.container.textContent).toContain('It can also be paid by Visa or Mastercard');
    view.unmount();
    withCards('soon');
    render(<RefundsPage />);
    expect(document.body.textContent).toContain('Today the fee is paid by MMG.');
    expect(document.body.textContent).not.toMatch(/visa|mastercard|coming soon/i);
  });
});
