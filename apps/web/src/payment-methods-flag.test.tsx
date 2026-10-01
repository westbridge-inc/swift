import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchState } from '@/site.config';

const REFUNDS_PAGE = join(process.cwd(), 'src', 'app', 'legal', 'refunds', 'page.tsx');

// ---------------------------------------------------------------------------
// [Q36 item 9] Card payments are honestly "coming soon" until the card rail is
// live — and the words follow launch.cardPayments, never literal text. The
// real footer and the real refunds page are loaded under each flag value, so a
// hand-typed "coming soon" (or a hand-typed "accepted") fails one of the two.
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

describe('[Q36] "coming soon" on the card methods follows launch.cardPayments', () => {
  it('while the card rail is not live, Visa and Mastercard say "coming soon" and cash and MMG do not', async () => {
    const { SiteFooter } = await withCards('soon');
    render(<SiteFooter />);
    expect(cardItems().map((item) => item.textContent)).toEqual(['Visacoming soon', 'Mastercardcoming soon']);
    const region = screen.getByRole('region', { name: 'Payment methods' });
    for (const method of ['Cash', 'MMG']) {
      expect(within(region).getAllByRole('listitem').find((item) => item.textContent?.startsWith(method))?.textContent).toBe(method);
    }
    expect(region.textContent).toContain("are for Swift's weekly partner fee and are coming soon.");
  });

  it('the moment the flag says live, "coming soon" is gone from the footer and from the refunds page', async () => {
    const { SiteFooter, refundsPage } = await withCards('live');
    render(<SiteFooter />);
    expect(cardItems().map((item) => item.textContent)).toEqual(['Visa', 'Mastercard']);
    const RefundsPage = await refundsPage();
    render(<RefundsPage />);
    expect(document.body.textContent).not.toMatch(/coming soon/i);
    expect(document.body.textContent).toContain('It can also be paid by Visa or Mastercard');
  });

  it('and the refunds page says "coming soon" while it is not', async () => {
    const RefundsPage = await (await withCards('soon')).refundsPage();
    render(<RefundsPage />);
    expect(document.body.textContent).toContain('Paying by Visa or Mastercard, through our bank’s card payment page, is coming soon.');
  });
});
