import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MoverDetail } from './MoverDetail';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-2] The rider and driver pages.
//
// The old page offered "Verify documents" whatever the documents said, dropped
// the server's refusal (409 CHECKLIST_INCOMPLETE) and the ride-class answer,
// and showed "Not found." for any failed load. Now the checklist decides what
// is offered, every answer is shown in words, and a failed load says so.
// ---------------------------------------------------------------------------

const REASON = 'Checked the licence and the insurance certificate in person';

const rider = {
  id: 'rider-1', riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false, isOnline: false,
  vehicleMake: 'Honda', vehicleModel: 'CG125', vehicleColor: 'Red', licensePlate: 'CJ 1234', averageRating: 5, totalRatings: 0,
  totalDeliveries: 0, subscription: null, earnings: [], _count: { orders: 0, earnings: 0 },
  user: { id: 'user-rider', firstName: 'Test', lastName: 'Rider', phone: 'rider-phone', status: 'ACTIVE', createdAt: '2026-09-01T00:00:00.000Z' },
};

const item = (docType: string, state: string) => ({ docType, state, documentId: state === 'MISSING' ? null : `d-${docType}`, submittedAt: null, expiresAt: null, note: null, renewalPending: false });

function checklist(next: string, items = [item('national_id', 'APPROVED'), item('drivers_licence', 'PENDING')]) {
  return {
    moverId: 'rider-1', kind: 'RIDER', applicantId: 'user-rider', vehicleType: 'MOTORCYCLE', documentsVerified: next === 'VERIFIED',
    checklist: { items, complete: next !== 'NEEDS_DOCUMENTS' }, live: { allowed: next === 'CAN_VERIFY' || next === 'VERIFIED', reason: next === 'NEEDS_DOCUMENTS' ? 'docs' : 'ok' }, next,
  };
}

function serve(profile: unknown, list: unknown, onWrite?: (_r: ApiRequest) => { status?: number; body: unknown }) {
  return mockApi((request) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/riders/rider-1') {
      return profile instanceof Error
        ? { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } }
        : { body: { success: true, data: profile } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/riders/rider-1/activation-checklist') return { body: { success: true, data: list } };
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/drivers/driver-1') return { body: { success: true, data: profile } };
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/drivers/driver-1/activation-checklist') return { body: { success: true, data: list } };
    if (onWrite && request.method !== 'GET') return onWrite(request);
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

describe('[MC-PR2] rider page', () => {
  it('waiting for documents: shows the checklist and the next step, and offers no Verify', async () => {
    serve(rider, checklist('NEEDS_DOCUMENTS'));
    renderWithQuery(<MoverDetail id="rider-1" kind="rider" />);
    const panel = await screen.findByRole('region', { name: /Required documents · Motorcycle/ });
    expect(within(panel).getByText('1 of 2 approved')).toBeTruthy();
    expect(within(panel).getByText(/Waiting for documents\. Decide each one in the Review Center/)).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open in Review Center' }).getAttribute('href')).toBe('/verification?applicant=user-rider');
    expect(screen.queryByRole('button', { name: /^Verify/ })).toBeNull();
  });

  it('when the gate allows it, Verify… runs through the reason panel and a refusal arrives in words', async () => {
    const fetchMock = serve(rider, checklist('CAN_VERIFY', [item('national_id', 'APPROVED')]), () => ({
      status: 409,
      body: { success: false, error: { code: 'CHECKLIST_INCOMPLETE', message: 'This rider’s required documents are not all approved and current — review them in the Verification queue first.' } },
    }));
    const { user } = renderWithQuery(<MoverDetail id="rider-1" kind="rider" />);
    await user.click(await screen.findByRole('button', { name: 'Verify…' }));
    const dialog = screen.getByRole('dialog', { name: "Verify Test Rider's documents?" });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Verify documents' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Approve the required documents in Verification first');
    expect(within(alert).getByRole('link', { name: 'Open in Review Center' }).getAttribute('href')).toBe('/verification?applicant=user-rider');
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/admin\/riders\/rider-1\/verify-documents$/);
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });

  it('a failed load says it could not load the rider — not "Not found"', async () => {
    serve(new Error('down'), checklist('NEEDS_DOCUMENTS'));
    renderWithQuery(<MoverDetail id="rider-1" kind="rider" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load this rider");
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('Not found.')).toBeNull();
  });
});

describe('[MC-PR2] driver page', () => {
  it('the ride class is changed through the reason panel, in plain words, and the answer is shown', async () => {
    const driver = { ...rider, id: 'driver-1', vehicleType: 'CAR', rideClass: 'ECONOMY', user: { ...rider.user, id: 'user-driver', lastName: 'Driver' } };
    const fetchMock = serve(driver, { ...checklist('VERIFIED'), moverId: 'driver-1', kind: 'DRIVER', applicantId: 'user-driver', vehicleType: 'CAR' }, () => ({ body: { success: true, data: { ...driver, rideClass: 'COMFORT' } } }));
    const { user } = renderWithQuery(<MoverDetail id="driver-1" kind="driver" />);
    const estate = await screen.findByRole('button', { name: 'Estate' });
    expect(screen.getByRole('button', { name: 'Car' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(estate);
    const dialog = screen.getByRole('dialog', { name: "Set Test Driver's ride class to Estate?" });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Change ride class' }));
    expect((await screen.findByRole('status')).textContent).toContain('Test Driver now drives Estate rides.');
    const [, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ rideClass: 'COMFORT' });
    expect(screen.queryByText(/ECONOMY|COMFORT/)).toBeNull();
  });
});
