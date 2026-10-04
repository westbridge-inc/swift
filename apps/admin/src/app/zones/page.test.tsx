import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ZonesPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { fareProblem } from '@/lib/zoneFares';

// ---------------------------------------------------------------------------
// [ZONE-FARES] The zones screen: zones with their own per-km rate, and the
// fixed zone-to-zone fares an admin adds, changes and removes.
//
// Every write is platform pricing on the server (a reason, then a second
// admin), so the screen must (1) ask the operator why, (2) send the pair with
// the price, (3) say "queued for a second admin" on the 202 instead of showing
// the change as made — no optimistic update — and (4) show the server's own
// refusal when there is one.
// ---------------------------------------------------------------------------

const REASON = 'The owner set this fare on the October call';
const ZONES = [
  { id: 'cjia-airport', name: 'CJIA Airport', countryCode: 'GY', isActive: true, priority: 0, taxiPerKm: 295 },
  { id: 'georgetown-central', name: 'Georgetown Central', countryCode: 'GY', isActive: true, priority: 0, taxiPerKm: null },
  { id: 'georgetown-south', name: 'Georgetown South', countryCode: 'GY', isActive: true, priority: 0, taxiPerKm: null },
];
const PAIR = {
  id: 'zf_1', fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south', fromZoneName: 'Georgetown Central',
  toZoneName: 'Georgetown South', countryCode: 'GY', fare: 2000, zonesActive: true, updatedBy: null, updatedAt: '2026-10-01T00:00:00Z',
};

type Write = { method: string; path: string; body: unknown; reason: string | null };

function server(reply: (w: Write) => { status: number; body: unknown }) {
  const writes: Write[] = [];
  const fetchMock = mockApi((request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/zone-fares') {
      return { body: { success: true, data: { fares: [PAIR], zones: ZONES } } };
    }
    if (request.url.pathname.startsWith('/api/v1/admin/zone-fares')) {
      const headers = new Headers(request.init?.headers);
      const w = { method: request.method, path: request.url.pathname, body: request.init?.body ? JSON.parse(String(request.init.body)) : null, reason: headers.get('x-swift-reason') };
      writes.push(w);
      return reply(w);
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  return { writes, fetchMock };
}

const queued = () => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens. It is in the approvals queue.', details: { approvalId: 'apr_1' } } } });

describe('[ZONE-FARES] the zones screen', () => {
  it('lists every zone with its own per-km rate, and every fixed fare by its zones and price', async () => {
    server(queued);
    renderWithQuery(<ZonesPage />);
    const cjia = (await screen.findByText('CJIA Airport')).closest('tr')!;
    expect(within(cjia).getByText('$295')).toBeTruthy();
    expect(within(screen.getByText('Georgetown Central', { selector: 'td' }).closest('tr')!).getByText('market rate')).toBeTruthy();
    const fare = screen.getByText('$2,000').closest('tr')!;
    expect(within(fare).getByText('Georgetown Central')).toBeTruthy();
    expect(within(fare).getByText('Georgetown South')).toBeTruthy();
  });

  it('adding a fare asks why, sends the pair and the whole fare with the reason, and says it is queued — it never shows the fare as made', async () => {
    const { writes } = server(queued);
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(REASON);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add fixed fare' }));
    await user.selectOptions(screen.getByLabelText('From zone'), 'georgetown-central');
    await user.selectOptions(screen.getByLabelText('To zone'), 'cjia-airport');
    await user.type(screen.getByLabelText('Fare (whole amount)'), '12000');
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toMatch(/add this fixed fare to \$12,000 for Georgetown Central → CJIA Airport/);
    expect(writes).toEqual([{ method: 'POST', path: '/api/v1/admin/zone-fares', body: { fromZoneId: 'georgetown-central', toZoneId: 'cjia-airport', fare: 12000 }, reason: REASON }]);
    expect(await screen.findByText(/Queued for a second admin/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /approvals queue/ }).getAttribute('href')).toBe('/approvals');
    // no optimistic row: the list is still the server's
    expect(screen.queryByText('$12,000')).toBeNull();
  });

  it('a cancelled reason prompt sends nothing', async () => {
    const { writes } = server(queued);
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(writes).toEqual([]);
  });

  it('editing sends the new fare WITH the pair it belongs to; deleting sends the pair', async () => {
    const { writes } = server(queued);
    vi.spyOn(window, 'prompt').mockReturnValue(REASON);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const fare = screen.getByLabelText('Fare (whole amount)');
    expect((screen.getByLabelText('From zone') as HTMLSelectElement).disabled).toBe(true);
    await user.clear(fare);
    await user.type(fare, '2500');
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    await screen.findByText(/Queued for a second admin/);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findAllByText(/Queued for a second admin/);
    expect(writes).toEqual([
      { method: 'PUT', path: '/api/v1/admin/zone-fares/zf_1', body: { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south', fare: 2500 }, reason: REASON },
      { method: 'DELETE', path: '/api/v1/admin/zone-fares/zf_1', body: { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south' }, reason: REASON },
    ]);
  });

  it('the server\'s refusal is shown as it said it', async () => {
    server(() => ({ status: 409, body: { success: false, error: { code: 'ZONE_FARE_EXISTS', message: 'This pair already has a fixed fare. Change that one instead of adding a second.' } } }));
    vi.spyOn(window, 'prompt').mockReturnValue(REASON);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add fixed fare' }));
    await user.selectOptions(screen.getByLabelText('From zone'), 'georgetown-central');
    await user.selectOptions(screen.getByLabelText('To zone'), 'georgetown-south');
    await user.type(screen.getByLabelText('Fare (whole amount)'), '2000');
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This pair already has a fixed fare. Change that one instead of adding a second.');
  });

  it('a fare the server would refuse is never sent: whole, 100 to 1,000,000', async () => {
    expect(fareProblem('')).toBe('Enter the fare.');
    expect(fareProblem('1500.5')).toMatch(/whole amount/);
    expect(fareProblem('99')).toMatch(/between 100 and 1,000,000/);
    expect(fareProblem('1000001')).toMatch(/between/);
    expect(fareProblem('100')).toBeNull();
    expect(fareProblem('1000000')).toBeNull();
    const { writes } = server(queued);
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(REASON);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add fixed fare' }));
    await user.selectOptions(screen.getByLabelText('From zone'), 'georgetown-central');
    await user.selectOptions(screen.getByLabelText('To zone'), 'cjia-airport');
    await user.type(screen.getByLabelText('Fare (whole amount)'), '99');
    expect((screen.getByRole('button', { name: 'Send for approval' }) as HTMLButtonElement).disabled).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
