import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeleteInfoPage from '@/app/(marketing)/account/delete/page';
import { CUSTOMER_ROUTE_NEUTRAL, CUSTOMER_ROUTE_OPEN, CUSTOMER_ROUTE_SOON } from './customer-delete-route';

// ---------------------------------------------------------------------------
// [FLOW-QA2 NEW-2] The public how-to page told customers to open Account > Personal details on the website. Before
// launch every /account page on the public site is the "Launching soon" page, so that step did not exist. The
// customer's line now follows the server's answer: the website route once customer pages are open, the app and email
// before, and a sentence true in both while the answer is not known (what the page is served with).
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ open: false, soon: false }));
vi.mock('@/lib/use-web-ordering', () => ({ useWebOrderingOpen: () => state.open, useWebOrderingSoon: () => state.soon }));

const customerLine = () => document.querySelector('[data-customer-delete-route]')?.textContent ?? null;

beforeEach(() => { state.open = false; state.soon = false; });

describe('[FLOW-QA2 NEW-2] the customer line on /account/delete is true before and after launch', () => {
  it('live (customer pages open): the website route', () => {
    state.open = true;
    render(<DeleteInfoPage />);
    expect(customerLine()).toBe(CUSTOMER_ROUTE_OPEN);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toContain('A customer: Account, then Personal details, then Delete my account');
  });

  it('before launch: no website route is offered; the app and email are', () => {
    state.soon = true;
    render(<DeleteInfoPage />);
    expect(customerLine()).toBe(CUSTOMER_ROUTE_SOON);
    expect(customerLine()).not.toMatch(/Personal details/);
    expect(customerLine()).toMatch(/at launch/);
    expect(customerLine()).toMatch(/in the app/);
    expect(customerLine()).toMatch(/by email/);
  });

  it('while the answer is not known (the page as served): words true in both states', () => {
    render(<DeleteInfoPage />);
    expect(customerLine()).toBe(CUSTOMER_ROUTE_NEUTRAL);
    expect(customerLine()).toMatch(/once customer pages are open on the website/);
  });

  it('the store and the rider or driver lines are unchanged (their pages are open before launch)', () => {
    state.soon = true;
    render(<DeleteInfoPage />);
    const routes = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(routes).toEqual(expect.arrayContaining([
      'A store: Account, then Request account closure (owners) or Delete my account (managers and staff)',
      'A rider or driver: Account, then Delete my account',
    ]));
  });
});
