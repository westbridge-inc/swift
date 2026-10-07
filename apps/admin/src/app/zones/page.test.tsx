import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
// [MC-PR3b] The reason is asked in the page's own panel (never a browser
// prompt), and a refusal stays in that panel with the reason still typed.
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

function server(reply: (_w: Write) => { status: number; body: unknown }, data: { fares: unknown[]; zones: unknown[] } = { fares: [PAIR], zones: ZONES }) {
  const writes: Write[] = [];
  const fetchMock = mockApi((request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/zone-fares') {
      return { body: { success: true, data } };
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

/** Answers the in-page reason panel: types `reason` and sends. Returns the panel. */
async function giveReason(user: UserEvent, title: string | RegExp, reason = REASON) {
  const dialog = await screen.findByRole('dialog', { name: title });
  await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), reason);
  await user.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
  return dialog;
}

const queued = () => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens. It is in the approvals queue.', details: { approvalId: 'apr_1' } } } });
const QUEUED = /Sent for a second admin.s approval/;

describe('[ZONE-FARES] the zones screen', () => {
  it('lists every zone with its own per-km rate, and every fixed fare by its zones and price', async () => {
    server(queued);
    renderWithQuery(<ZonesPage />);
    const cjia = (await screen.findByText('CJIA Airport')).closest('tr')!;
    expect(within(cjia).getByText('$295')).toBeTruthy();
    expect(within(screen.getByText('georgetown-central').closest('tr')!).getByText('market rate')).toBeTruthy();
    const fare = screen.getByText('$2,000').closest('tr')!;
    expect(within(fare).getByText('Georgetown Central')).toBeTruthy();
    expect(within(fare).getByText('Georgetown South')).toBeTruthy();
  });

  it('adding a fare asks why, sends the pair and the whole fare with the reason, and says it is queued — it never shows the fare as made', async () => {
    const { writes } = server(queued);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add fixed fare' }));
    await user.selectOptions(screen.getByLabelText('From zone'), 'georgetown-central');
    await user.selectOptions(screen.getByLabelText('To zone'), 'cjia-airport');
    await user.type(screen.getByLabelText('Fare (whole amount)'), '12000');
    await user.click(screen.getByRole('button', { name: 'Send for approval…' }));
    // nothing is sent before the operator says why
    expect(writes).toEqual([]);
    await giveReason(user, 'Add a fixed fare of $12,000 for Georgetown Central → CJIA Airport?');

    expect(writes).toEqual([{ method: 'POST', path: '/api/v1/admin/zone-fares', body: { fromZoneId: 'georgetown-central', toZoneId: 'cjia-airport', fare: 12000 }, reason: REASON }]);
    expect(await screen.findByText(QUEUED)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Approvals' }).getAttribute('href')).toBe('/approvals');
    // no optimistic row: the list is still the server's
    expect(screen.queryByText('$12,000')).toBeNull();
  });

  it('a cancelled reason panel sends nothing', async () => {
    const { writes } = server(queued);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete Georgetown Central → Georgetown South…' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove the fixed fare Georgetown Central → Georgetown South?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('editing sends the new fare WITH the pair it belongs to; deleting sends the pair', async () => {
    const { writes } = server(queued);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: /^Edit / }));
    const fare = screen.getByLabelText('Fare (whole amount)');
    expect((screen.getByLabelText('From zone') as HTMLSelectElement).disabled).toBe(true);
    await user.clear(fare);
    await user.type(fare, '2500');
    await user.click(screen.getByRole('button', { name: 'Send for approval…' }));
    await giveReason(user, 'Change the fixed fare Georgetown Central → Georgetown South to $2,500?');
    await screen.findByText(QUEUED);
    await user.click(screen.getByRole('button', { name: /^Delete / }));
    await giveReason(user, /^Remove the fixed fare/);
    await screen.findAllByText(QUEUED);
    expect(writes).toEqual([
      { method: 'PUT', path: '/api/v1/admin/zone-fares/zf_1', body: { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south', fare: 2500 }, reason: REASON },
      { method: 'DELETE', path: '/api/v1/admin/zone-fares/zf_1', body: { fromZoneId: 'georgetown-central', toZoneId: 'georgetown-south' }, reason: REASON },
    ]);
  });

  it('the server\'s refusal is shown as it said it — in the panel, with the reason still typed and the form still filled', async () => {
    server(() => ({ status: 409, body: { success: false, error: { code: 'ZONE_FARE_EXISTS', message: 'This pair already has a fixed fare. Change that one instead of adding a second.' } } }));
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add fixed fare' }));
    await user.selectOptions(screen.getByLabelText('From zone'), 'georgetown-central');
    await user.selectOptions(screen.getByLabelText('To zone'), 'georgetown-south');
    await user.type(screen.getByLabelText('Fare (whole amount)'), '2000');
    await user.click(screen.getByRole('button', { name: 'Send for approval…' }));
    const dialog = await giveReason(user, /^Add a fixed fare of \$2,000/);
    expect((await within(dialog).findByRole('alert')).textContent).toContain('This pair already has a fixed fare. Change that one instead of adding a second.');
    expect((within(dialog).getByRole('textbox', { name: 'Reason' }) as HTMLTextAreaElement).value).toBe(REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect((screen.getByLabelText('Fare (whole amount)') as HTMLInputElement).value).toBe('2000');
  });

  it('a fare the server would refuse is never sent: whole, 100 to 1,000,000', async () => {
    expect(fareProblem('')).toBe('Enter the fare.');
    expect(fareProblem('1500.5')).toMatch(/whole amount/);
    expect(fareProblem('99')).toMatch(/between 100 and 1,000,000/);
    expect(fareProblem('1000001')).toMatch(/between/);
    expect(fareProblem('100')).toBeNull();
    expect(fareProblem('1000000')).toBeNull();
    const { writes } = server(queued);
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add fixed fare' }));
    await user.selectOptions(screen.getByLabelText('From zone'), 'georgetown-central');
    await user.selectOptions(screen.getByLabelText('To zone'), 'cjia-airport');
    await user.type(screen.getByLabelText('Fare (whole amount)'), '99');
    expect((screen.getByRole('button', { name: 'Send for approval…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('[ZONE-FARES · Sol F2] the fare form always shows the row being edited', () => {
  const OTHER = {
    ...PAIR, id: 'zf_2', fromZoneId: 'georgetown-south', toZoneId: 'georgetown-central',
    fromZoneName: 'Georgetown South', toZoneName: 'Georgetown Central', fare: 2400,
  };
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;

  it('Edit A, then Edit B without cancelling: the form shows B, and sends B\'s pair to B', async () => {
    const { writes } = server(queued, { fares: [PAIR, OTHER], zones: ZONES });
    const { user } = renderWithQuery(<ZonesPage />);
    const edits = await screen.findAllByRole('button', { name: /^Edit / });
    await user.click(edits[0]!);
    expect([field('From zone').value, field('To zone').value, field('Fare (whole amount)').value]).toEqual(['georgetown-central', 'georgetown-south', '2000']);
    await user.click(screen.getAllByRole('button', { name: /^Edit / })[1]!);
    expect([field('From zone').value, field('To zone').value, field('Fare (whole amount)').value]).toEqual(['georgetown-south', 'georgetown-central', '2400']);
    const fare = field('Fare (whole amount)');
    await user.clear(fare);
    await user.type(fare, '2500');
    await user.click(screen.getByRole('button', { name: 'Send for approval…' }));
    await giveReason(user, 'Change the fixed fare Georgetown South → Georgetown Central to $2,500?');
    await screen.findByText(QUEUED);
    expect(writes).toEqual([{ method: 'PUT', path: '/api/v1/admin/zone-fares/zf_2', body: { fromZoneId: 'georgetown-south', toZoneId: 'georgetown-central', fare: 2500 }, reason: REASON }]);
  });

  it('Edit, then Add: the new form is empty, not the edited row', async () => {
    server(queued, { fares: [PAIR, OTHER], zones: ZONES });
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click((await screen.findAllByRole('button', { name: /^Edit / }))[0]!);
    await user.click(screen.getByRole('button', { name: 'Add fixed fare' }));
    expect([field('From zone').value, field('To zone').value, field('Fare (whole amount)').value]).toEqual(['', '', '']);
    expect((field('From zone') as HTMLSelectElement).disabled).toBe(false);
  });
});

describe('[ZONE-FARES · Sol F3] a fixed fare joins two zones of ONE market — the console never asks for anything else', () => {
  const MIXED = [...ZONES, { id: 'port-of-spain', name: 'Port of Spain', countryCode: 'TT', isActive: true, priority: 0, taxiPerKm: null }];
  const options = (label: string) => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);

  it('once a From zone is chosen, the To zone offers only zones of its market', async () => {
    server(queued, { fares: [], zones: MIXED });
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add fixed fare' }));
    await user.selectOptions(screen.getByLabelText('From zone'), 'georgetown-central');
    expect(options('To zone')).not.toContain('port-of-spain');
    expect(options('To zone')).toContain('cjia-airport');
  });

  it('a pair that ends up across two markets is refused before any reason is asked or request sent', async () => {
    const { writes } = server(queued, { fares: [], zones: MIXED });
    const { user } = renderWithQuery(<ZonesPage />);
    await user.click(await screen.findByRole('button', { name: 'Add fixed fare' }));
    await user.selectOptions(screen.getByLabelText('From zone'), 'port-of-spain');
    await user.selectOptions(screen.getByLabelText('To zone'), 'port-of-spain');
    await user.selectOptions(screen.getByLabelText('From zone'), 'georgetown-central');
    await user.type(screen.getByLabelText('Fare (whole amount)'), '3000');
    expect(screen.getByText('Both zones must be in the same market.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send for approval…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes).toEqual([]);
  });
});
