import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalHome from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { moverNextStep, moverNextWords } from '@/lib/first-steps';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · owner 1 Nov 2026] A rider or taxi driver who has just signed up on the website lands on the
// earner office. It showed earnings tiles and nothing about documents. Like the app's mover onboarding screen, a
// mover not yet cleared now reads, at the top, how many documents are left to send (with the way to the Documents
// page) or that Swift is reading them. Once cleared, nothing. Synthetic values only.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllGlobals(); });

const doc = (docType: string, status: string) => ({ id: `${docType}-1`, docType, status, expiresAt: null, reviewNote: null, createdAt: '2026-11-01T12:00:00.000Z' });
const MOTOR = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'];

function riderHome(verification: unknown) {
  return mockApi(({ url }) => {
    const path = url.pathname;
    if (path === '/api/v1/rider/profile') return { body: { data: { id: 'rider-1', vehicleType: 'MOTORCYCLE' } } };
    if (path === '/api/v1/driver/profile') return { status: 404, body: { error: 'No driver profile' } };
    if (path === '/api/v1/verification/status') return { body: { data: verification } };
    if (path === '/api/v1/rider/earnings/summary') return { body: { data: {
      today: { total: 0, count: 0 }, thisWeek: { total: 0, count: 0 }, thisMonth: { total: 0, count: 0 }, allTime: { total: 0, count: 0 },
    } } };
    if (path === '/api/v1/rider/subscription') return { body: { data: null } };
    if (path === '/api/v1/rider/cash-settlements') return { body: { data: { unsettled: [], settled: [], summary: { owed: 0, count: 0 } } } };
    return { status: 404, body: { success: false } };
  });
}

describe('[WEB-ONBOARDING] the earner office says what is left before going online', () => {
  it('documents still to send: the count, and the way to the Documents page', async () => {
    riderHome({ checklist: MOTOR, documents: [doc('drivers_licence', 'PENDING')], missing: MOTOR, roleVerified: false });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText('2 documents to send before you can go online.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Upload your documents' }).getAttribute('href')).toBe('/portal/documents');
  });

  it('everything sent: Swift is reading them; no upload button', async () => {
    riderHome({ checklist: MOTOR, documents: MOTOR.map((t) => doc(t, 'PENDING')), missing: MOTOR, roleVerified: false });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText(moverNextWords({ kind: 'review' }))).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Upload your documents' })).toBeNull();
  });

  it('cleared to work: nothing', async () => {
    riderHome({ checklist: MOTOR, documents: MOTOR.map((t) => doc(t, 'APPROVED')), missing: [], roleVerified: true });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText('Earnings')).toBeTruthy();
    expect(screen.queryByText(/before you can go online|before you go online/)).toBeNull();
  });
});

describe('[WEB-ONBOARDING] whose turn it is, document by document', () => {
  it('never sent, sent back or out of date is the mover’s; one Swift is reading or approved is not; the clearance never counts', () => {
    const status = (documents: Array<{ docType: string; status: string }>) => ({ checklist: [...MOTOR, 'police_clearance'], documents, roleVerified: false });
    expect(moverNextStep(status([]))).toEqual({ kind: 'send', count: 3 });
    expect(moverNextStep(status([doc('drivers_licence', 'REJECTED'), doc('vehicle_registration', 'EXPIRED'), doc('vehicle_insurance', 'APPROVED')]))).toEqual({ kind: 'send', count: 2 });
    // The newest copy wins: a new copy waiting for review replaces a rejected one.
    expect(moverNextStep(status([doc('drivers_licence', 'PENDING'), doc('drivers_licence', 'REJECTED'), doc('vehicle_registration', 'PENDING'), doc('vehicle_insurance', 'APPROVED')]))).toEqual({ kind: 'review' });
    expect(moverNextStep({ ...status([]), roleVerified: true })).toBeNull();
    expect(moverNextStep(undefined)).toBeNull();
    expect(moverNextStep({ checklist: MOTOR, documents: [] })).toBeNull();
    expect(moverNextWords({ kind: 'send', count: 1 })).toBe('1 document to send before you can go online.');
  });
});
