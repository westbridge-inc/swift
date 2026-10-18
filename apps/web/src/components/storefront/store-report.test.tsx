import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [R19 · Child Safety Standards · legal research E10] The website had no report surface at all. A store page now
// has "Report this store" with the phone's reasons, Child safety (CSAE) among them; a report needs a signed-in
// person (a guest is sent to sign in); the server pages operations at once for CSAE.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ signedIn: true, push: vi.fn(), report: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fx.push, replace: vi.fn() }) }));
vi.mock('@/components/customer-session', () => ({
  useCustomerSession: () => ({ status: fx.signedIn ? 'signed-in' : 'guest', ensureSignedIn: async () => fx.signedIn }),
}));
vi.mock('@/components/account/account-frame', () => ({ useAccountQuery: () => ({ data: [], isFetching: false, refetch: vi.fn() }) }));
vi.mock('@/components/account/account-api', () => ({ accountApi: { favourites: vi.fn(), favourite: vi.fn() } }));
vi.mock('@/lib/report-reasons', async () => {
  const actual = await vi.importActual<typeof import('@/lib/report-reasons')>('@/lib/report-reasons');
  return { ...actual, reportContent: fx.report };
});

import { StoreActions } from './store-actions';
import { CHILD_SAFETY_REASON, STORE_REPORT_REASONS } from '@/lib/report-reasons';

function renderActions(onMessage = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient()}><StoreActions vendorId="v1" slug="test-shop" name="Test shop" onMessage={onMessage} /></QueryClientProvider>);
  return onMessage;
}

beforeEach(() => { fx.signedIn = true; fx.push.mockReset(); fx.report.mockReset(); });

describe('the website store report', () => {
  it('offers the phone’s reasons, Child safety (CSAE) among them, and files the one picked', async () => {
    fx.report.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    const onMessage = renderActions();
    await user.click(screen.getByRole('button', { name: 'Report this store' }));
    const dialog = screen.getByRole('dialog', { name: 'Report this store' });
    expect([...dialog.querySelectorAll('li button')].map((b) => b.textContent)).toEqual(STORE_REPORT_REASONS.map((r) => r.label));
    await user.click(screen.getByRole('button', { name: CHILD_SAFETY_REASON.label }));
    expect(fx.report).toHaveBeenCalledWith({ targetType: 'VENDOR', targetId: 'v1', reason: 'CSAE' });
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('Thank you. Child-safety reports go to a person on our team straight away.'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a guest is sent to sign in, and nothing is filed', async () => {
    fx.signedIn = false;
    const user = userEvent.setup();
    renderActions();
    await user.click(screen.getByRole('button', { name: 'Report this store' }));
    await user.click(screen.getByRole('button', { name: 'Misleading or spam' }));
    expect(fx.report).not.toHaveBeenCalled();
    expect(fx.push).toHaveBeenCalled();
  });

  it('the website’s reasons are the phone’s, word for word, and use the server’s codes', () => {
    const phone = readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'lib', 'reportReasons.ts'), 'utf8');
    for (const r of STORE_REPORT_REASONS) expect(phone).toContain(`label: '${r.label}'`);
    const server = readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'moderation', 'moderation.routes.ts'), 'utf8');
    for (const r of STORE_REPORT_REASONS) expect(server).toContain(`'${r.key}'`);
  });
});
