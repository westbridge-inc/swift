import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MoverWeeklyFeePage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { LEGAL_ACCEPTED_EVENT } from '@/lib/legal-acceptance';

// [BILL-PRO PR6 · owner A4/B3] A pro pays their own weekly fee on the website (Partner portal, Weekly fee), the same
// server answer as the phone: the fee words and the amount to tick, the store fee that covers them, or the fee.
afterEach(() => { vi.unstubAllGlobals(); });

const TERMS = {
  version: 'v1', tick: 'I understand the weekly fee.', amount: 8000, currencyCode: 'GYD', acknowledged: false,
  items: [{ heading: 'What it covers', text: 'The Swift app and its tools for your work.' }, { heading: 'How you pay', text: 'In the Swift app, on MMG’s checkout page, one week at a time.' }],
};
const FEE_TERMS = { required: true, operable: false, why: 'FEE_TERMS', source: null, subscriptionId: null };
const absentMover = (path: string) => (path === '/api/v1/rider/profile' || path === '/api/v1/driver/profile' ? { status: 404, body: { success: false, error: { message: 'No profile' } } } : null);
const approved = (path: string) => (path === '/api/v1/services/providers/me' ? { body: { success: true, data: { id: 'sp1', isVerified: true } } } : null);

describe('the portal weekly-fee page for a service provider', () => {
  it('shows the server\'s fee words and amount with the tick, says the tick starts the fee, and sends exactly them', async () => {
    const posted: unknown[] = [];
    mockApi(({ url, method, init }) => {
      const canned = absentMover(url.pathname) ?? approved(url.pathname);
      if (canned) return canned;
      if (url.pathname === '/api/v1/provider/subscription') return { body: { success: true, data: null, standing: FEE_TERMS, coveredBy: null, feeTerms: TERMS } };
      if (url.pathname === '/api/v1/provider/weekly-fee-ack' && method === 'POST') { posted.push(JSON.parse(String(init?.body))); return { body: { success: true, data: { acknowledged: true } } }; }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    renderWithQuery(<MoverWeeklyFeePage />);
    expect(await screen.findByText('Service provider')).toBeTruthy();
    // The pro's block loads after the page (perf budget), then shows the server's words.
    expect(await screen.findByText('The weekly fee for service providers: GY$8,000/week')).toBeTruthy();
    expect(screen.getByText('The Swift app and its tools for your work.')).toBeTruthy();
    expect(screen.getByText(/^Ticking this starts your weekly fee today/)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    await waitFor(() => expect(posted).toEqual([{ version: 'v1', amount: 8000, currencyCode: 'GYD' }]));
  });

  it('a pro covered by their Services store\'s fee is told so, with nothing to pay here', async () => {
    mockApi(({ url }) => absentMover(url.pathname) ?? approved(url.pathname) ?? (url.pathname === '/api/v1/provider/subscription'
      ? { body: { success: true, data: null, standing: { required: true, operable: true, why: null, source: 'STORE', subscriptionId: 's1' }, coveredBy: 'STORE', feeTerms: { ...TERMS, acknowledged: true } } }
      : (() => { throw new Error(url.pathname); })()));
    renderWithQuery(<MoverWeeklyFeePage />);
    expect(await screen.findByText('Your store’s weekly fee covers you')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('[REVIEW-F #2231 S3-4] accepting the agreement on the site reads the pro\'s standing and fee again', async () => {
    let accepted = false;
    mockApi(({ url }) => absentMover(url.pathname) ?? approved(url.pathname) ?? (url.pathname === '/api/v1/provider/subscription'
      ? { body: { success: true, data: null, standing: accepted ? FEE_TERMS : { ...FEE_TERMS, why: 'AGREEMENT' }, coveredBy: null, feeTerms: TERMS } }
      : (() => { throw new Error(url.pathname); })()));
    renderWithQuery(<MoverWeeklyFeePage />);
    expect(await screen.findByText('Accept the Business Agreement first')).toBeTruthy();
    accepted = true;
    window.dispatchEvent(new Event(LEGAL_ACCEPTED_EVENT));
    expect(await screen.findByText(/^Ticking this starts your weekly fee today/)).toBeTruthy();
    expect(screen.queryByText('Accept the Business Agreement first')).toBeNull();
  });

  it('nobody with no earner or provider profile sees a fee', async () => {
    mockApi(({ url }) => absentMover(url.pathname) ?? (url.pathname === '/api/v1/provider/subscription'
      ? { status: 404, body: { success: false, error: { message: 'ServiceProvider not found' } } }
      : (() => { throw new Error(url.pathname); })()));
    renderWithQuery(<MoverWeeklyFeePage />);
    expect(await screen.findByText('No earner profile on this account.')).toBeTruthy();
  });

  it('[REVIEW-F/M #2238 N1] an approval read that fails says so, never "starts after approval" to an approved pro', async () => {
    mockApi(({ url }) => absentMover(url.pathname) ?? (url.pathname === '/api/v1/services/providers/me'
      ? { status: 500, body: { success: false, error: { message: 'down' } } }
      : url.pathname === '/api/v1/provider/subscription'
        ? { body: { success: true, data: null, standing: { ...FEE_TERMS, why: 'MISSING' }, coveredBy: null, feeTerms: { ...TERMS, acknowledged: true } } }
        : (() => { throw new Error(url.pathname); })()));
    renderWithQuery(<MoverWeeklyFeePage />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load/);
    expect(screen.queryByText('Your weekly fee starts after approval')).toBeNull();
  });
});
