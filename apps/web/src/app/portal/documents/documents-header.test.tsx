import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentsPage from './page';
import { renderWithQuery } from '@/test/test-utils';
import * as moverApi from '@/lib/mover-api';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · FLOW-QA F17 + F18] The rider/taxi Documents page.
//  - F17: its header said "1 document still needed before you can go online" after that document was sent (the
//    server's `missing` counts a copy waiting for review). It now counts what the mover still has to send (never sent,
//    sent back, out of date), and once everything is in: "In review — nothing more needed from you."
//  - F18: it opened with "Upload renewals on a big screen", a line for movers already approved. A new mover reads
//    "Send these documents to start." first; the renewal line stays for an approved mover. Synthetic values only.
// ---------------------------------------------------------------------------

const MOTOR = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
const doc = (docType: string, status: string) => ({ id: `${docType}-1`, docType, status, expiresAt: status === 'APPROVED' ? '2030-01-01T00:00:00.000Z' : null, reviewNote: null, createdAt: '2026-11-01T12:00:00.000Z' });
const open = (documents: ReturnType<typeof doc>[], roleVerified = false) => {
  vi.spyOn(moverApi, 'getVerificationStatus').mockResolvedValue({ checklist: MOTOR, documents, missing: roleVerified ? [] : MOTOR, roleVerified } as never);
  renderWithQuery(<DocumentsPage />);
};

beforeEach(() => { vi.spyOn(moverApi, 'getRiderProfile').mockResolvedValue({ vehicleType: 'MOTORCYCLE' } as never); });
afterEach(() => { vi.restoreAllMocks(); });

describe('[F17] the header counts what is left to send', () => {
  it('one sent, two to send', async () => {
    open([doc('drivers_licence', 'PENDING')]);
    expect(await screen.findByText('2 documents to send before you can go online.')).toBeTruthy();
    expect(screen.queryByText(/3 documents still needed/)).toBeNull();
  });

  it('everything sent: in review, nothing more needed', async () => {
    open(MOTOR.map((t) => doc(t, 'PENDING')));
    expect(await screen.findByText('In review — nothing more needed from you.')).toBeTruthy();
    expect(screen.queryByText(/still needed|to send before/)).toBeNull();
  });

  it('approved: cleared to work', async () => {
    open(MOTOR.map((t) => doc(t, 'APPROVED')), true);
    expect(await screen.findByText('You are fully verified and cleared to work.')).toBeTruthy();
  });
});

describe('[F18] a new mover reads how to start first; the renewal line is for approved movers', () => {
  it('not approved yet', async () => {
    open([]);
    expect(await screen.findByText(/^Send these documents to start\./)).toBeTruthy();
    expect(screen.queryByText(/Upload renewals on a big screen/)).toBeNull();
  });

  it('approved', async () => {
    open(MOTOR.map((t) => doc(t, 'APPROVED')), true);
    expect(await screen.findByText(/^Upload renewals on a big screen/)).toBeTruthy();
    expect(screen.queryByText(/Send these documents to start/)).toBeNull();
  });
});
