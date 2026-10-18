import type { ReactElement } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AdsReviewPage from './ads/page';
import AuditPage from './audit/page';
import CashPage from './cash/page';
import ClaimsPage from './claims/page';
import CompliancePage from './compliance/page';
import ConfigPage from './config/page';
import CustodyCasesPage from './custody/page';
import DiscoveryPage from './discovery/page';
import FinancePage from './finance/page';
import MarketsPage from './markets/page';
import ModerationPage from './moderation/page';
import OpsPage from './ops/page';
import PromosPage from './promos/page';
import ReturnsPage from './returns/page';
import SubscriptionsPage from './subscriptions/page';
import { ReviewerAccess } from '@/components/verification/ReviewerAccess';
import { CatalogueApproverAccess } from '@/components/verification/CatalogueApproverAccess';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// The live map pulls in Leaflet, which needs a real browser; the map is not under test here.
vi.mock('next/dynamic', () => ({ default: () => () => null }));

// ---------------------------------------------------------------------------
// [ADMIN-TRUTH] A FAILED READ IS NEVER "NOTHING TO DO".
//
// These console screens read the API with useQuery and never looked at the
// query's error. A 403 or a 500 rendered as zeros or as the reassuring empty
// state: Compliance printed "Nobody is operating outside the rules" while it
// could not see a single mover, Finance showed GY$0 revenue, Claims "No pending
// review claims". Each case below makes the screen's reads fail and asserts the
// failure IS shown (the shared QueryFailed: "Couldn't load …") and that the
// all-clear / empty / zero copy is NOT.
// ---------------------------------------------------------------------------

const FAILED = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } } };

type Ok = Record<string, unknown>;

interface Case {
  name: string;
  ui: () => ReactElement;
  /** GET paths that answer normally (exact pathname → body); every other GET fails. */
  ok?: Ok;
  /** Clicks or other steps to reach the panel under test. */
  reach?: (_user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  /** The failure that must be shown (each one, by its QueryFailed sentence). */
  failure: RegExp[];
  /** Copy that must NOT be shown while the read has failed. */
  never: RegExp[];
}

const custodyRow = {
  id: 'case-1', orderId: 'order-1', state: 'SUPPORT_HOLD', reason: 'CUSTOMER_UNREACHABLE', overdue: false,
  createdAt: '2026-10-01T00:00:00.000Z', order: { orderNumber: 'SW-1', vendor: { name: 'Test Store' } },
};
const subscriptionRow = {
  id: 'sub-1', type: 'VENDOR', status: 'ACTIVE', weeklyRate: 2100, customRate: null, feeWaived: false,
  nextBillingDate: '2026-10-20T00:00:00.000Z', trialEndsAt: null, vendor: { id: 'v1', name: 'Test Store' },
};

const CASES: Case[] = [
  {
    name: 'compliance',
    ui: () => <CompliancePage />,
    failure: [/Couldn.t load the compliance checks/],
    never: [/Nobody is operating outside the rules/, /No open cases/, /No runs yet/, /Open violations/],
  },
  {
    name: 'finance',
    ui: () => <FinancePage />,
    failure: [/Couldn.t load the revenue figures/, /Couldn.t load the payment mix/, /Couldn.t load the MMG cash ledger/, /Couldn.t load the sales digests/],
    never: [/No completed orders/, /Nothing here/, /GY\$0/, /\b0 unsettled handovers/],
  },
  {
    name: 'claims',
    ui: () => <ClaimsPage />,
    failure: [/Couldn.t load the claims/, /Couldn.t load the claim numbers/, /Couldn.t load the reserve line/],
    never: [/No pending review claims/, /GY\$0/, /\b0 approved claims/],
  },
  {
    name: 'subscriptions',
    ui: () => <SubscriptionsPage />,
    failure: [/Couldn.t load the subscriptions/],
    never: [/No subscriptions match/],
  },
  {
    name: 'subscriptions → billing trail',
    ui: () => <SubscriptionsPage />,
    ok: { '/api/v1/admin/subscriptions': { success: true, data: [subscriptionRow] } },
    reach: async (user) => { await user.click(await screen.findByRole('button', { name: 'Billing trail' })); },
    failure: [/Couldn.t load the billing trail/],
    never: [/No billing events/],
  },
  {
    name: 'audit',
    ui: () => <AuditPage />,
    failure: [/Couldn.t load the audit log/],
    never: [/No audit events yet/],
  },
  {
    name: 'ops',
    ui: () => <OpsPage />,
    failure: [/Couldn.t load live ops/],
    never: [/Nothing moving right now/, /IN FLIGHT \(0\)/],
  },
  {
    name: 'returns',
    ui: () => <ReturnsPage />,
    failure: [/Couldn.t load the returns/],
    never: [/No requested returns/],
  },
  {
    name: 'markets',
    ui: () => <MarketsPage />,
    failure: [/Couldn.t load the markets/],
    never: [/No markets configured/],
  },
  {
    name: 'config',
    ui: () => <ConfigPage />,
    failure: [/Couldn.t load the platform configuration/],
    never: [/Launch switches/, /Save Configuration/],
  },
  {
    name: 'custody',
    ui: () => <CustodyCasesPage />,
    failure: [/Couldn.t load the custody cases/],
    never: [/No open custody cases/],
  },
  {
    name: 'custody → one case',
    ui: () => <CustodyCasesPage />,
    ok: { '/api/v1/admin/custody-cases': { success: true, data: [custodyRow] } },
    reach: async (user) => { await user.click(await screen.findByRole('button', { name: /Order SW-1/ })); },
    failure: [/Couldn.t load this custody case/],
    never: [],
  },
  {
    name: 'promos',
    ui: () => <PromosPage />,
    failure: [/Couldn.t load the promo codes/],
    never: [/No promo codes yet/],
  },
  {
    name: 'cash',
    ui: () => <CashPage />,
    failure: [/Couldn.t load the cash rail figures/],
    never: [/No figures yet/, /Every payment reached an account/],
  },
  {
    name: 'discovery → requests',
    ui: () => <DiscoveryPage />,
    failure: [/Couldn.t load the category requests/],
    never: [/Nothing in this queue/, /of 0 categories are visible/],
  },
  {
    name: 'discovery → taxonomy',
    ui: () => <DiscoveryPage />,
    reach: async (user) => { await user.click(await screen.findByRole('button', { name: 'Taxonomy' })); },
    failure: [/Couldn.t load the categories/],
    never: [/of 0 categories are visible/],
  },
  {
    name: 'moderation → content',
    ui: () => <ModerationPage />,
    failure: [/Couldn.t load the reported content/],
    never: [/Nothing pending/, /\(0\)/],
  },
  {
    name: 'moderation → reported reviews',
    ui: () => <ModerationPage />,
    reach: async (user) => { await user.click(await screen.findByRole('button', { name: /Reported reviews/ })); },
    failure: [/Couldn.t load the reported reviews/],
    never: [/No reported reviews waiting/, /\(0\)/],
  },
  {
    name: 'moderation → held reviews',
    ui: () => <ModerationPage />,
    reach: async (user) => { await user.click(await screen.findByRole('button', { name: /Held reviews/ })); },
    failure: [/Couldn.t load the held reviews/],
    never: [/Nothing is being held/, /\(0\)/],
  },
  {
    name: 'ads → advertisers',
    ui: () => <AdsReviewPage />,
    failure: [/Couldn.t load the advertisers/],
    never: [/Nothing in pending review/, /\(0\)/],
  },
  {
    name: 'ads → creatives',
    ui: () => <AdsReviewPage />,
    reach: async (user) => { await user.click(await screen.findByRole('button', { name: /Creatives/ })); },
    failure: [/Couldn.t load the creatives/],
    never: [/No creatives waiting for review/, /\(0\)/],
  },
  {
    name: 'verification → who may open documents',
    ui: () => <ReviewerAccess />,
    failure: [/Couldn.t load who may open documents/],
    never: [],
  },
  {
    name: 'verification → who may approve catalogue items',
    ui: () => <CatalogueApproverAccess />,
    failure: [/Couldn.t load who may approve catalogue items/],
    never: [],
  },
];

describe('[ADMIN-TRUTH] a failed read shows the failure, never the all-clear', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    mockApi((request: ApiRequest) => {
      if (request.method === 'GET' && c.ok && request.url.pathname in c.ok) return { body: c.ok[request.url.pathname] };
      return FAILED;
    });
    const { user } = renderWithQuery(c.ui());
    if (c.reach) await c.reach(user);
    for (const failure of c.failure) {
      expect(await screen.findByText(failure, undefined, { timeout: 3000 }), String(failure)).toBeTruthy();
    }
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    const text = document.body.textContent ?? '';
    for (const never of c.never) expect(text, `must not show ${never} while blind`).not.toMatch(never);
  });

  it('the document-reviewer panels stay absent on the designed 403 (not a super-admin)', async () => {
    mockApi(() => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Founder access required' } } }));
    renderWithQuery(<><ReviewerAccess /><CatalogueApproverAccess /></>);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.body.textContent ?? '').not.toMatch(/Couldn.t load/);
  });
});
