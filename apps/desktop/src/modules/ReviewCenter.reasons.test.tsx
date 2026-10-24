import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { REASON_CODES } from '../lib/api';
import ReviewCenter from './ReviewCenter';

// ---------------------------------------------------------------------------
// [Owner ruling 2026-10-01] A yellow car is NOT a requirement for a taxi; the H plate
// stays required. The Review Center is where a reviewer picks the category of a
// rejection, so it must no longer offer "Not Yellow" — and it must still offer the
// H-plate reason, the one taxi vehicle rule that remains.
// ---------------------------------------------------------------------------

const fixture = vi.hoisted(() => ({
  photo: {
    id: 'doc-exterior-1',
    docType: 'vehicle_exterior_photo',
    role: 'MOVER',
    status: 'PENDING',
    createdAt: '2026-10-01T10:00:00.000Z',
    expiresAt: null,
    reviewNote: null,
    user: { id: 'user-taxi-1', firstName: 'Taxi', lastName: 'Driver', phone: '+5926000001', countryCode: 'GY' },
  },
}));

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchReviewQueue: vi.fn(async () => ({ rows: [fixture.photo], meta: { total: 1, totalPages: 1 } })),
  fetchReviewApplicant: vi.fn(async () => ({
    id: 'user-taxi-1',
    firstName: 'Taxi',
    lastName: 'Driver',
    phone: '+5926000001',
    rider: null,
    vendorOwner: null,
    driver: { vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleColor: 'White', licensePlate: 'HB 1234' },
  })),
  documentViewUrl: vi.fn(async () => {
    throw new Error('Preview unavailable in this test.');
  }),
  custodyNarrative: vi.fn(async () => {
    throw new Error('Custody unavailable in this test.');
  }),
}));

/** The codes the server accepts for a NEW decision (verification.service REJECTION_REASON_CODES). */
function serverReasonCodes(): string[] {
  const src = readFileSync(join(process.cwd(), '../api/src/modules/verification/verification.service.ts'), 'utf8');
  const block = /export const REJECTION_REASON_CODES = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error('REJECTION_REASON_CODES not found in the API verification service');
  return [...block[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

describe('[owner ruling 2026-10-01] the Review Center offers no colour reason', () => {
  it('the reject panel for a taxi exterior photo offers no "Not Yellow", and still offers the H-plate reason', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    render(
      <QueryClientProvider client={client}>
        <ReviewCenter />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /Prepare rejection/ }));
    // The panel prints each code with its underscores as spaces ("WRONG_PLATE_CLASS" → "WRONG PLATE CLASS").
    const categories = within(screen.getByLabelText('Reject reason category'))
      .getAllByRole('button')
      .map((button) => (button.textContent ?? '').trim().toUpperCase());

    expect(categories.length).toBeGreaterThan(5);
    expect(categories).not.toContain('NOT YELLOW');
    expect(categories.join(' | ')).not.toMatch(/YELLOW|COLOU?R/);
    expect(categories).toContain('WRONG PLATE CLASS');
  });

  it('offers exactly the codes the server accepts for a new decision, in the same order', () => {
    const server = serverReasonCodes();
    expect(server.length).toBeGreaterThan(5); // the parse found the list: never a vacuous match
    expect(server).not.toContain('NOT_YELLOW');
    expect([...REASON_CODES]).toEqual(server);
  });
});
