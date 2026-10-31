import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import DocumentsPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import * as moverApi from '@/lib/mover-api';

// ---------------------------------------------------------------------------
// [REPLACE-PENDING · owner request 8 Oct 2026] "Can't change a submitted document if I accidentally sent the
// wrong one." A document waiting for review offers "Replace this document"; a copy that replaced an earlier
// one says "Replaced — waiting for review"; an approved document stays locked until its renewal window.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const doc = (docType: string, status: string, over: Record<string, unknown> = {}) => ({
  id: `${docType}-1`, docType, status, expiresAt: null, reviewNote: null, createdAt: '2026-10-08T12:00:00.000Z', ...over,
});

function status(documents: unknown[]) {
  return { roleKey: 'MOVER', checklist: ['national_id', 'drivers_licence', 'vehicle_insurance', 'vehicle_registration'], documents, missing: ['national_id'], roleVerified: false };
}

beforeEach(() => { vi.spyOn(moverApi, 'getRiderProfile').mockResolvedValue({ vehicleType: 'MOTORCYCLE' } as never); });
afterEach(() => { vi.restoreAllMocks(); });

describe('driver documents page', () => {
  it('a waiting document can be replaced; a replaced one says so; an approved one is locked', async () => {
    vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue(status([
      doc('national_id', 'PENDING'),
      doc('drivers_licence', 'PENDING', { replaced: true }),
      doc('vehicle_insurance', 'APPROVED', { expiresAt: new Date(Date.now() + 200 * DAY).toISOString() }),
    ]) as never);
    renderWithQuery(<DocumentsPage />);
    expect(await screen.findByText('Replaced — waiting for review')).toBeTruthy();
    expect(screen.getAllByText('In review')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Replace this document' })).toHaveLength(2);
    // Approved and not near renewal: no upload button for it; the missing one can be uploaded.
    expect(screen.queryByRole('button', { name: 'Upload renewal' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Upload' })).toHaveLength(1);
  });

  it('an approved document near its renewal opens for the renewal', async () => {
    vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue(status([
      doc('vehicle_insurance', 'APPROVED', { expiresAt: new Date(Date.now() + 10 * DAY).toISOString() }),
    ]) as never);
    renderWithQuery(<DocumentsPage />);
    expect(await screen.findByRole('button', { name: 'Upload renewal' })).toBeTruthy();
  });
});

// [FOLLOWUPS] The expiry printed is the day on the document, whatever zone the browser is in: the keyed "28 Oct"
// (stored as midnight UTC) never reads as the 27th in Guyana (UTC-4) or anywhere west of UTC.
describe('[FOLLOWUPS] the expiry is the day on the document', () => {
  const ZONE = process.env['TZ'];
  afterEach(() => { process.env['TZ'] = ZONE; });
  for (const zone of ['America/Guyana', 'Pacific/Honolulu', 'Asia/Tokyo']) {
    it(`${zone}: "expires 28 Oct 2031"`, async () => {
      process.env['TZ'] = zone;
      vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue(status([
        doc('vehicle_insurance', 'APPROVED', { expiresAt: '2031-10-28T00:00:00.000Z' }),
      ]) as never);
      renderWithQuery(<DocumentsPage />);
      expect(await screen.findByText('expires 28 Oct 2031')).toBeTruthy();
      expect(document.body.textContent).not.toContain('27 Oct');
    });
  }
});


// ---------------------------------------------------------------------------
// [WEB-POLICE · owner 31 Oct 2026] A TAXI driver may add a police clearance on the website (optional; an approved,
// current one records the account as police-cleared; it never gates), the phone's way: its OWN consent in the API's
// words, never the privacy-notice tick. A delivery rider is never offered one, whatever a list says. Synthetic values.
// ---------------------------------------------------------------------------

const TAXI = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance', 'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'];
const TAXI_WORDS = {
  tick: 'police_clearance_v1', kind: 'taxi', version: 'taxi-v1-31d',
  text: 'Optional. I choose to upload my police clearance. (synthetic words)',
  withdrawConfirm: 'Swift stops using your police clearance now and deletes it. Your account is no longer recorded as police-cleared. (synthetic)',
};
const moverStatus = (checklist: string[], over: Record<string, unknown> = {}) => ({
  roleKey: 'MOVER', checklist, documents: [], missing: checklist, roleVerified: false, optional: ['police_clearance'], policeClearanceConsent: TAXI_WORDS, ...over,
});

describe('[WEB-POLICE] the police clearance on the rider/driver Documents page', () => {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  beforeEach(() => {
    writes.length = 0;
    mockApi(({ method, url, init }) => {
      const path = url.pathname.replace('/api/v1', '');
      writes.push({ method, path, body: init?.body instanceof FormData ? 'file' : init?.body ? JSON.parse(String(init.body)) : null });
      if (path === '/verification/upload') return { body: { success: true, data: { url: 'verification/user-1/synthetic.enc' } } };
      return { status: 201, body: { success: true, data: {} } };
    });
  });

  it('a taxi driver: offered under Optional with its own box in the API’s words; files it with its own tick and version', async () => {
    vi.spyOn(moverApi, 'getRiderProfile').mockResolvedValue({ vehicleType: 'CAR' } as never);
    vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue(moverStatus(TAXI) as never);
    renderWithQuery(<DocumentsPage />);
    const optional = (await screen.findByRole('heading', { name: 'Optional' })).closest('section') as HTMLElement;
    expect(within(optional).getByText('Police Clearance Certificate')).toBeTruthy();
    expect(within(optional).getByText('Optional. If Swift approves a current one, your account is recorded as police-cleared.')).toBeTruthy();
    const box = within(optional).getByRole('checkbox', { name: /I choose to upload my police clearance/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    const cardButton = within(optional).getByText('Police Clearance Certificate').closest('button') as HTMLButtonElement;
    expect(cardButton.disabled).toBe(true);
    fireEvent.click(box);
    expect(cardButton.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Choose a file for Police Clearance Certificate'), { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ method: 'POST', path: '/verification/documents', body: {
      role: 'MOVER', docType: 'police_clearance', fileUrl: 'verification/user-1/synthetic.enc', consent: true, privacyNoticeVersion: 'web-v1',
      consentTick: 'police_clearance_v1', consentVersion: 'taxi-v1-31d', consentVia: 'checkbox',
    } });
    // It never joins the required list's ordinary upload buttons.
    expect(screen.getAllByRole('button', { name: 'Upload' })).toHaveLength(TAXI.length);
  });

  it.each([
    ['a motorbike rider', 'MOTORCYCLE', ['drivers_licence', 'vehicle_registration', 'vehicle_insurance']],
    ['a bicycle rider', 'BICYCLE', ['national_id']],
  ])('%s is never offered one, even if a list named it', async (_name, vehicleType, checklist) => {
    vi.spyOn(moverApi, 'getRiderProfile').mockResolvedValue({ vehicleType } as never);
    vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue(moverStatus(checklist) as never);
    renderWithQuery(<DocumentsPage />);
    await screen.findByText(`${checklist.length} document${checklist.length === 1 ? '' : 's'} still needed before you can go online.`);
    expect(screen.queryByText(/Police Clearance/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Optional' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /police clearance/ })).toBeNull();
  });

  it('a taxi driver without the API’s words: nothing is taken (no box, no file input)', async () => {
    vi.spyOn(moverApi, 'getRiderProfile').mockResolvedValue({ vehicleType: 'CAR' } as never);
    vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue(moverStatus(TAXI, { policeClearanceConsent: undefined }) as never);
    renderWithQuery(<DocumentsPage />);
    expect(await screen.findByText(/its consent words did not load/)).toBeTruthy();
    expect(screen.queryByLabelText('Choose a file for Police Clearance Certificate')).toBeNull();
  });

  it('a police clearance in a mover’s required list never gets the privacy-notice upload', async () => {
    vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue(moverStatus(['national_id', 'police_clearance'], { optional: [] }) as never);
    renderWithQuery(<DocumentsPage />);
    await screen.findByText('National ID or Digital ID card');
    expect(screen.queryByText(/Police Clearance/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Upload' })).toHaveLength(1);
  });
});
