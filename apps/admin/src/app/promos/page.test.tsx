import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PromosPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

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

// ---------------------------------------------------------------------------
// [U62] "New promo code" was not a dialog, and a stray click on the backdrop
// threw the typed form away. It is the shared dialog now; once anything is
// typed only Cancel closes it. Creating goes through the reason panel, and the
// form comes back, values kept, if the operator cancels or is refused.
// ---------------------------------------------------------------------------
describe('[U62] the new promo form is a dialog that keeps what was typed', () => {
  it('is a labelled dialog; a stray backdrop click does not close a typed form', async () => {
    mockApi(handler());
    const { user } = renderWithQuery(<PromosPage />);
    await user.click(await screen.findByRole('button', { name: /create promo/i }));
    expect(screen.getByRole('dialog', { name: 'New promo code' })).toBeTruthy();
    await user.type(screen.getByLabelText('Code'), 'welcome10');
    await user.click(screen.getByTestId('promo-form-overlay'));
    expect(screen.getByRole('dialog', { name: 'New promo code' })).toBeTruthy();
    expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('WELCOME10');
  });

  it('Create asks why in the panel; a refusal brings the form back with the values kept', async () => {
    const fetchMock = mockApi((request: ApiRequest): ApiReply => {
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/promos') return { body: { success: true, data: [] } };
      if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/promos') {
        return { status: 409, body: { success: false, error: { code: 'PROMO_CODE_TAKEN', message: 'That code is already in use.' } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<PromosPage />);
    await user.click(await screen.findByRole('button', { name: /create promo/i }));
    await user.type(screen.getByLabelText('Code'), 'welcome10');
    await user.type(screen.getByLabelText('Description'), '10% off your first order');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const panel = await screen.findByRole('dialog', { name: /Create the promo code WELCOME10\?/ });
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'Launch week welcome offer agreed with the owner');
    await user.click(within(panel).getByRole('button', { name: 'Create promo code' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain('That code is already in use.');
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1);
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'New promo code' })).toBeTruthy());
    expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('WELCOME10');
  });
});
