import { screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import CashPage from './page';
it('labels agent cash as received money and offers no intake', async () => {
  mockApi(({ url }) => ({ body: { success: true, data: url.pathname.endsWith('/cash-kpis') ? null : [] } }));
  renderWithQuery(<CashPage />);
  expect(await screen.findByRole('heading', { name: 'Agent cash already received' })).toBeTruthy();
  expect(screen.getByText(/Resolve money already received/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Received cash' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^(Collect|Add payment|New payment)$/i })).toBeNull();
});
