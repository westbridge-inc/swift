import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { LEGAL_RECHECK_EVENT } from '@/lib/legal-acceptance';
import { PRO_FEE_COVERED_TICK_LINE, PRO_FEE_OWN_FEE_LINK, PRO_FEE_RUNNING_TICK_LINE, type ProFeeStanding, type ProFeeView } from '@/lib/provider-fee';

vi.mock('@/components/weekly-fee', () => ({ WeeklyFee: ({ family }: { family: string }) => <p>The {family} weekly fee</p> }));
import { ProviderFeeBlock } from './provider-fee';

// [BILL-PRO PR6 · REVIEW-F #2231 S3/S4 · REVIEW-G #2230 S3-1] The website's pro fee block says what the phone's pro fee
// screen says, from the same server answer.
afterEach(() => { vi.unstubAllGlobals(); });

const TERMS = {
  version: 'v1', tick: 'I understand the weekly fee.', amount: 8000, currencyCode: 'GYD', acknowledged: false,
  items: [{ heading: 'What it covers', text: 'The Swift app and its tools for your work.' }],
};
const FEE_TERMS: ProFeeStanding = { required: true, operable: false, why: 'FEE_TERMS', source: null, subscriptionId: null };
const AGREEMENT: ProFeeStanding = { ...FEE_TERMS, why: 'AGREEMENT' };
const STARTS = /^Ticking this starts your weekly fee today/;
const block = (view: ProFeeView, isVerified = true) => <ProviderFeeBlock view={view} isVerified={isVerified} />;

describe('the tick on the website', () => {
  it('[S4] the agreement not accepted: never "ticking this starts your fee"; the agreement card with its Review button, next to the tick', () => {
    const asked = vi.fn();
    window.addEventListener(LEGAL_RECHECK_EVENT, asked);
    try {
      renderWithQuery(block({ data: null, standing: AGREEMENT, feeTerms: TERMS }));
      expect(screen.getByText('Accept the Business Agreement first')).toBeTruthy();
      expect(screen.getByText(/^Your weekly fee can start only after you accept the Business Agreement/)).toBeTruthy();
      expect(screen.getByRole('checkbox')).toBeTruthy();
      expect(screen.queryByText(STARTS)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Review the agreement' }));
      expect(asked).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(LEGAL_RECHECK_EVENT, asked);
    }
  });

  it('[S4-4] only the tick missing (FEE_TERMS), for an approved pro: the tick starts the fee; no agreement card', () => {
    renderWithQuery(block({ data: null, standing: FEE_TERMS, feeTerms: TERMS }));
    expect(screen.getByText(STARTS)).toBeTruthy();
    expect(screen.queryByText('Accept the Business Agreement first')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review the agreement' })).toBeNull();
  });

  it('[S4-4] never says the tick starts the fee for a pro Swift has not approved', () => {
    renderWithQuery(block({ data: null, standing: FEE_TERMS, feeTerms: TERMS }, false));
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect(screen.queryByText(STARTS)).toBeNull();
  });

  it('[S3-1] a tick holds only for the amount it was given to: a new amount clears it', () => {
    const view = renderWithQuery(block({ data: null, standing: FEE_TERMS, feeTerms: TERMS }));
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false);
    view.rerender(block({ data: null, standing: FEE_TERMS, feeTerms: { ...TERMS, amount: 9000 } }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('[REVIEW-G #2230 S3-1] the fee changed since the tick: both amounts, asked again; the tick sends the new amount', async () => {
    const posted: unknown[] = [];
    mockApi(({ url, method, init }) => {
      if (url.pathname === '/api/v1/provider/weekly-fee-ack' && method === 'POST') { posted.push(JSON.parse(String(init?.body))); return { body: { success: true, data: { acknowledged: true } } }; }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    renderWithQuery(block({ data: null, standing: FEE_TERMS, feeTerms: { ...TERMS, amount: 9000, changed: true, acknowledgedAmount: 8000, acknowledgedCurrencyCode: 'GYD' } }));
    expect(screen.getByRole('alert').textContent).toBe('The weekly fee changed from GY$8,000 to GY$9,000 a week. Read it again and tick “I understand the weekly fee” to confirm the new amount. Nothing starts at the new amount until you do.');
    expect(screen.getByText('The weekly fee for service providers: GY$9,000/week')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(posted).toEqual([{ version: 'v1', amount: 9000, currencyCode: 'GYD' }]));
  });

  it('a fee in another currency is named in that currency, never as GY$', () => {
    renderWithQuery(block({ data: null, standing: FEE_TERMS, feeTerms: { ...TERMS, amount: 40, currencyCode: 'USD' } }));
    expect(screen.getByText('The weekly fee for service providers: USD 40/week')).toBeTruthy();
  });

  it('[S4-5] is never asked while the fee is not required (switch off), whatever the API serves', () => {
    renderWithQuery(block({ data: null, standing: { required: false, operable: true }, feeTerms: TERMS }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('No weekly fee yet')).toBeTruthy();
  });
});

describe('[S3-3 · S4-1 · S4-3] a covered pro, and a fee behind the tick', () => {
  it('a covered pro asked to tick is told why (never a second charge), and their own fee is one click away', () => {
    renderWithQuery(block({ data: { id: 's1' }, standing: FEE_TERMS, coveredBy: 'STORE', feeTerms: TERMS }));
    expect(screen.getByText('Your store’s weekly fee covers you')).toBeTruthy();
    expect(screen.getByText(PRO_FEE_COVERED_TICK_LINE)).toBeTruthy();
    expect(screen.queryByText(STARTS)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: PRO_FEE_OWN_FEE_LINK }));
    expect(screen.getByText('The provider weekly fee')).toBeTruthy();
  });

  it('a pro with a fee who must tick again (the amount changed) can still open the fee', () => {
    renderWithQuery(block({ data: { id: 's1' }, standing: FEE_TERMS, feeTerms: TERMS }));
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: PRO_FEE_OWN_FEE_LINK })).toBeTruthy();
    // [REVIEW-M #2238 S4-1] The fee already runs: never "Ticking this starts your weekly fee today" (no new trial).
    expect(screen.queryByText(STARTS)).toBeNull();
    expect(screen.getByText(PRO_FEE_RUNNING_TICK_LINE)).toBeTruthy();
  });

  it('[REVIEW-M #2238 S4-1] a running fee and the agreement not accepted: the card never says the fee "can start only after"', () => {
    renderWithQuery(block({ data: { id: 's1' }, standing: AGREEMENT, feeTerms: TERMS }));
    expect(screen.getByText('Accept the Business Agreement first')).toBeTruthy();
    expect(screen.queryByText(/can start only after/)).toBeNull();
    expect(screen.getByText(/^You are not listed and take no new jobs until you accept the Business Agreement/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review the agreement' })).toBeTruthy();
  });

  it('a fee and nothing to tick: the fee itself', () => {
    renderWithQuery(block({ data: { id: 's1' }, standing: { required: true, operable: true, why: null, source: 'OWN', subscriptionId: 's1' }, feeTerms: { ...TERMS, acknowledged: true } }));
    expect(screen.getByText('The provider weekly fee')).toBeTruthy();
  });
});

describe('[S3-2] no fee of their own: the words follow where the server says the pro stands', () => {
  const none = (standing: ProFeeStanding) => ({ data: null, standing, feeTerms: { ...TERMS, acknowledged: true } });
  it('agreement not accepted: asks for it, with the Review button', () => {
    renderWithQuery(block(none(AGREEMENT)));
    expect(screen.getByText('Accept the Business Agreement')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review the agreement' })).toBeTruthy();
  });
  it('documents not approved: starts after approval', () => {
    renderWithQuery(block(none({ ...FEE_TERMS, why: 'MISSING' }), false));
    expect(screen.getByText('Your weekly fee starts after approval')).toBeTruthy();
  });
  it('ticked and approved but not born yet: being set up', () => {
    renderWithQuery(block(none({ ...FEE_TERMS, why: 'MISSING' })));
    expect(screen.getByText('Your weekly fee is being set up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review the agreement' })).toBeNull();
  });
});

describe('the block\'s source', () => {
  it('keeps a tick only for its key, and the agreement card carries its words and the Review button', () => {
    const s = readFileSync(join(__dirname, 'provider-fee.tsx'), 'utf8');
    expect(s).toContain("const ticked = tick.kind === 'tick' && tickedFor === tick.key;");
    expect(s).not.toMatch(/useState\(false\);\s*\n[^\n]*setTicked\b/);
    const card = /\{agreementFirst \? <div[^>]*>((?:(?!<\/div>)[\s\S])*)<\/div>/.exec(s)?.[1] ?? '';
    expect(card).toContain('{agreementFirst.title}');
    expect(card).toContain('{agreementFirst.body}');
    expect(card).toContain('<ReviewAgreementButton />');
  });
});
