import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ probe: vi.fn(), restore: vi.fn(), pro: vi.fn(), fee: vi.fn(), router: { replace: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => mock.router }));
vi.mock('@/lib/auth', () => ({ sessionProbe: mock.probe, restoreSession: mock.restore, hasProviderProfile: mock.pro }));
vi.mock('@/lib/provider-fee-api', () => ({ getProviderFee: mock.fee }));
import { WeeklyFeeDestination } from './weekly-fee-destination';
beforeEach(() => { vi.resetAllMocks(); mock.restore.mockResolvedValue({ ok: false }); mock.pro.mockResolvedValue(false); mock.fee.mockResolvedValue(null); });
describe('neutral weekly-fee destination', () => {
  it.each([['VENDOR', '/dashboard/weekly-fee'], ['RIDER', '/portal/weekly-fee'], ['DRIVER', '/portal/weekly-fee'], ['MOVER', '/portal/weekly-fee']])('routes %s from the session only', async (role, route) => {
    mock.probe.mockResolvedValue({ ok: true, user: { roles: [role] } });
    render(<WeeklyFeeDestination />);
    await waitFor(() => expect(mock.router.replace).toHaveBeenCalledWith(route));
  });
  it('offers both destinations when the session has both roles', async () => {
    mock.probe.mockResolvedValue({ ok: true, user: { roles: ['VENDOR', 'RIDER'] } });
    render(<WeeklyFeeDestination />);
    expect((await screen.findByRole('link', { name: 'Business weekly fee' })).getAttribute('href')).toBe('/dashboard/weekly-fee');
    expect(screen.getByRole('link', { name: 'Earner weekly fee' }).getAttribute('href')).toBe('/portal/weekly-fee');
    expect(mock.router.replace).not.toHaveBeenCalled();
  });
  it('signs in then returns to the same neutral choice, without return parameters', async () => {
    mock.probe.mockResolvedValue({ ok: false });
    render(<WeeklyFeeDestination />);
    await waitFor(() => expect(mock.router.replace).toHaveBeenCalledWith('/login?next=%2Fweekly-fee'));
  });
  // [BILL-PRO PR6] A pro's MMG return lands on their own weekly fee; nobody else's does.
  it('a service provider (no partner role) returns to the portal weekly fee; anyone else is told there is no fee', async () => {
    mock.probe.mockResolvedValue({ ok: true, user: { roles: ['CUSTOMER'] } });
    mock.pro.mockResolvedValue(true);
    render(<WeeklyFeeDestination />);
    await waitFor(() => expect(mock.router.replace).toHaveBeenCalledWith('/portal/weekly-fee'));
  });
  it('a customer with no provider profile is told there is no fee', async () => {
    mock.probe.mockResolvedValue({ ok: true, user: { roles: ['CUSTOMER'] } });
    render(<WeeklyFeeDestination />);
    expect(await screen.findByText('No business or earner profile on this account.')).toBeTruthy();
    expect(mock.router.replace).not.toHaveBeenCalled();
  });
  it('restores an expired access session before choosing the mover portal', async () => {
    mock.probe.mockResolvedValue({ ok: false }); mock.restore.mockResolvedValue({ ok: true, user: { roles: ['RIDER'] } });
    render(<WeeklyFeeDestination />);
    await waitFor(() => expect(mock.router.replace).toHaveBeenCalledWith('/portal/weekly-fee'));
  });
  // [REVIEW-M #2238 S4-2 · REVIEW-F S4-2] A store owner who is also a pro: MMG's return goes to the fee whose checkout
  // they just came back from (the pro's own, when it was started in the last two hours); otherwise they choose, and
  // the pro fee is one of the choices (never only the store's fee).
  it('a store owner and pro back from their pro fee checkout lands on the pro fee', async () => {
    mock.probe.mockResolvedValue({ ok: true, user: { roles: ['VENDOR'] } });
    mock.pro.mockResolvedValue(true);
    mock.fee.mockResolvedValue({ data: { latestMmgCheckout: { ref: 'c1', status: 'CONFIRMING', createdAt: new Date(Date.now() - 5 * 60_000).toISOString() } } });
    render(<WeeklyFeeDestination />);
    await waitFor(() => expect(mock.router.replace).toHaveBeenCalledWith('/portal/weekly-fee'));
  });
  it('a store owner and pro with no recent pro checkout chooses, and the pro fee is a choice', async () => {
    mock.probe.mockResolvedValue({ ok: true, user: { roles: ['VENDOR'] } });
    mock.pro.mockResolvedValue(true);
    mock.fee.mockResolvedValue({ data: { latestMmgCheckout: { ref: 'c0', status: 'CONFIRMED', createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() } } });
    render(<WeeklyFeeDestination />);
    expect((await screen.findByRole('link', { name: 'Business weekly fee' })).getAttribute('href')).toBe('/dashboard/weekly-fee');
    expect(screen.getByRole('link', { name: 'Service provider weekly fee' }).getAttribute('href')).toBe('/portal/weekly-fee');
    expect(mock.router.replace).not.toHaveBeenCalled();
  });
  it('a store owner, earner and pro: the portal choice names both', async () => {
    mock.probe.mockResolvedValue({ ok: true, user: { roles: ['VENDOR', 'RIDER'] } });
    mock.pro.mockResolvedValue(true);
    render(<WeeklyFeeDestination />);
    expect((await screen.findByRole('link', { name: 'Earner and service provider weekly fees' })).getAttribute('href')).toBe('/portal/weekly-fee');
  });
});
