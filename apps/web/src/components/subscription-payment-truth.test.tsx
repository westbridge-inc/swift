import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SettingsPage from '@/app/dashboard/settings/page';
import PortalHome from '@/app/portal/page';
import { feeDate } from '@/lib/weekly-fee';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [FEE-STATUS · owner 25 Oct 2026] Dates still AHEAD of now for the neutral claims (these were fixed 5/7 Oct
// dates, which have since passed: the old line then read "next bill 7 Oct" on 25 Oct, the owner's bug). A
// passed date is its own case below.
const DAY = 86_400_000;
const periodEnd = new Date(Date.now() + 3 * DAY).toISOString();
const trialEnd = new Date(Date.now() + 2 * DAY).toISOString();
const passed = new Date(Date.now() - 4 * DAY).toISOString();

// [UI-SWEEP U46] The summary reads the fields the server sends (`nextBillingDate`,
// `trialEndDate`, `isTrialActive`) and says the status in the phone's words, never
// the code. The rule this file guards is unchanged: a date is never read as "paid".
describe('subscription summaries do not infer payment from period dates', () => {
  for (const family of ['vendor', 'rider', 'driver']) {
    it.each([['TRIAL', 'Free trial'], ['ACTIVE', 'Active']])('%s dates are neutral for ' + family, async (status, word) => {
      mockApi(({ url }) => {
        if (url.pathname.endsWith('/subscription')) return { body: { success: true, data: {
          status, weeklyRate: 1200, nextBillingDate: periodEnd, trialEndDate: trialEnd, isTrialActive: status === 'TRIAL',
          // [REVIEW-F2 #1930 S4-1] currentPeriodEnd is a real field too (MMG checkout API); kept so the date rule bites on it.
          currentPeriodEnd: periodEnd,
          latestMmgCheckout: null, recentCheckouts: [],
        } } };
        // The store's subscription card is the owner's (U20); the earner office has no roles.
        if (url.pathname === `/api/v1/${family}/profile`) return { body: { success: true, data: { id: 'test-profile', myRole: 'OWNER' } } };
        if (url.pathname.endsWith('/hours')) return { body: { success: true, data: [] } };
        return { body: { success: true, data: null } };
      });
      const view = renderWithQuery(family === 'vendor' ? <SettingsPage /> : <PortalHome />);
      const statusLabel = await screen.findByText(word);
      const card = statusLabel.closest('div')!;
      expect(card.textContent).not.toMatch(/paid/i);
      expect(view.container.textContent).not.toContain(status);
      if (status === 'TRIAL') expect(view.container.textContent).toContain(`Free trial until ${feeDate(trialEnd)}`);
      else expect(view.container.textContent).toContain(`Next weekly fee due on ${feeDate(periodEnd)}`);
      view.unmount();
    });

    it.each(['TRIAL', 'ACTIVE'])('%s with dates that have passed never reads a passed date as a trial end or a next bill for ' + family, async (status) => {
      mockApi(({ url }) => {
        if (url.pathname.endsWith('/subscription')) return { body: { success: true, data: {
          status, weeklyRate: 1200, nextBillingDate: passed, trialEndDate: passed, isTrialActive: status === 'TRIAL', currentPeriodEnd: passed,
          amountDueGyd: 1200, latestMmgCheckout: null, recentCheckouts: [],
        } } };
        if (url.pathname === `/api/v1/${family}/profile`) return { body: { success: true, data: { id: 'test-profile', myRole: 'OWNER' } } };
        if (url.pathname.endsWith('/hours')) return { body: { success: true, data: [] } };
        return { body: { success: true, data: null } };
      });
      const view = renderWithQuery(family === 'vendor' ? <SettingsPage /> : <PortalHome />);
      await screen.findByText('Payment due');
      const shown = view.container.textContent ?? '';
      expect(shown).toContain(`Payment due since ${feeDate(passed)}`);
      expect(shown).not.toMatch(/next bill|Trial ends|Free trial until|until \d/i);
      expect(shown).not.toContain(status);
      view.unmount();
    });
  }
});
