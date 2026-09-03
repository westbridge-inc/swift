import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PromosPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [A-22] Every field in the promo editor is programmatically labelled.
//
// The labels were rendered but never associated — no `htmlFor`, no `id` — so a
// screen reader announced each one as an unnamed edit box, and clicking a label
// did nothing. `getByLabelText` is exactly the query that fails when a control
// has no accessible name, which is why it is the assertion.
// ---------------------------------------------------------------------------
function handler() {
  return (request: ApiRequest) => {
    if (request.url.pathname === '/api/v1/admin/promos') {
      return { body: { success: true, data: [] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('[A-22] the promo editor names its fields', () => {
  it('every control has an accessible name a label points at', async () => {
    mockApi(handler());
    const { user } = renderWithQuery(<PromosPage />);

    await user.click(await screen.findByRole('button', { name: /create promo/i }));

    for (const label of ['Code', 'Description', 'Type', 'Valid from', 'Valid until']) {
      expect(screen.getByLabelText(label), label).toBeTruthy();
    }
    // The value field renames itself with the type, and stays labelled either way.
    expect(screen.getByLabelText('Value (%)')).toBeTruthy();
  });
});
