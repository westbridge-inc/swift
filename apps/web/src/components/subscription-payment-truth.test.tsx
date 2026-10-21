import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SettingsPage from '@/app/dashboard/settings/page';
import PortalHome from '@/app/portal/page';
import { feeDate } from '@/lib/weekly-fee';
import { mockApi, renderWithQuery } from '@/test/test-utils';

const periodEnd = '2026-10-07T12:00:00Z';
const trialEnd = '2026-10-05T12:00:00Z';

// [UI-SWEEP U46] The summary reads the fields the server sends (`nextBillingDate`,
// `trialEndDate`, `isTrialActive`) and says the status in the phone's words, never
// the code. The rule this file guards is unchanged: a date is never read as "paid".
describe('subscription summaries do not infer payment from period dates', () => {
  for (const family of ['vendor', 'rider', 'driver']) {
    it.each([['TRIAL', 'Free trial'], ['ACTIVE', 'Active']])('%s dates are neutral for ' + family, async (status, word) => {
      mockApi(({ url }) => {
        if (url.pathname.endsWith('/subscription')) return { body: { success: true, data: {
          status, weeklyRate: 1200, nextBillingDate: periodEnd, trialEndDate: trialEnd, isTrialActive: status === 'TRIAL',
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
      if (status === 'TRIAL') expect(view.container.textContent).toContain(`Trial ends ${feeDate(trialEnd)}`);
      else expect(view.container.textContent).toContain(`next bill ${feeDate(periodEnd)}`);
      view.unmount();
    });
  }
});
