import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SettingsPage from '@/app/dashboard/settings/page';
import PortalHome from '@/app/portal/page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

const periodEnd = '2026-10-07T12:00:00Z';
const trialEnd = '2026-10-05T12:00:00Z';

describe('subscription summaries do not infer payment from period dates', () => {
  for (const family of ['vendor', 'rider', 'driver']) {
    it.each(['TRIAL', 'ACTIVE'])('%s dates are neutral for ' + family, async (status) => {
      mockApi(({ url }) => {
        if (url.pathname.endsWith('/subscription')) return { body: { success: true, data: {
          status, weeklyRate: 1200, currentPeriodEnd: periodEnd, trialEndsAt: trialEnd,
          latestMmgCheckout: null, recentCheckouts: [],
        } } };
        if (url.pathname === `/api/v1/${family}/profile`) return { body: { success: true, data: { id: 'test-profile' } } };
        if (url.pathname.endsWith('/hours')) return { body: { success: true, data: [] } };
        return { body: { success: true, data: null } };
      });
      const view = renderWithQuery(family === 'vendor' ? <SettingsPage /> : <PortalHome />);
      const statusLabel = await screen.findByText(status);
      const card = statusLabel.closest('div')!;
      expect(card.textContent).not.toMatch(/paid/i);
      expect(view.container.textContent).toContain(`Next bill: ${new Date(periodEnd).toLocaleDateString()}`);
      if (status === 'TRIAL') expect(view.container.textContent).toContain(`Free trial until ${new Date(trialEnd).toLocaleDateString()}`);
      view.unmount();
    });
  }
});
