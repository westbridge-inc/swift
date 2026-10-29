import { screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import DocumentsPage from './page';
import { renderWithQuery } from '@/test/test-utils';
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

