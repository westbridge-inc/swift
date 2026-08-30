import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import IntegrityPage from './page';
import { mockApi, renderWithQuery, type ApiReply, type ApiRequest } from '@/test/test-utils';

/** The reader contract (final as of #938): sentences are the interface,
 *  rendered verbatim; the `inputs` evidence Json rides the wire but its signal
 *  tokens must NEVER reach the DOM; the only action is "open the subject". */

const baseFlags = [
  {
    id: 'flag-gps',
    algo: 'ALG-15',
    subjectType: 'RIDER',
    subjectId: 'rider-1234567890',
    outcome: 'FLAGGED',
    sentence:
      'Rider moved 4.1 km in 12 s during delivery #1042 — faster than any vehicle on these roads.',
    inputs: { signals: ['impossible_speed_v1', 'teleport_jump_v1'], maxKmh: 1230 },
    configVersion: 'v1',
    createdAt: '2026-08-29T21:00:00.000Z',
  },
  {
    id: 'flag-ato',
    algo: 'ALG-34',
    subjectType: 'VENDOR',
    subjectId: 'vendor-987654321',
    outcome: 'STAGED',
    sentence: 'MMG pay link change staged for 24 h; the old contact was told.',
    inputs: { signals: ['payout_link_change_v1'] },
    configVersion: 'v2',
    createdAt: '2026-08-29T20:00:00.000Z',
  },
];

function flagsHandler(
  flags = baseFlags,
  onRequest?: (_url: URL) => void,
): (_request: ApiRequest) => ApiReply {
  return (request) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/integrity/flags') {
      onRequest?.(request.url);
      return { body: { success: true, data: { flags, windowDays: 7 } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('integrity review page', () => {
  it('renders each flag as its sentence, verbatim, asking for the contract defaults', async () => {
    mockApi(
      flagsHandler(baseFlags, (url) => {
        expect(url.searchParams.get('days')).toBe('7');
        expect(url.searchParams.get('limit')).toBe('50');
        expect(url.searchParams.get('algo')).toBeNull();
        expect(url.searchParams.get('subjectType')).toBeNull();
      }),
    );
    renderWithQuery(<IntegrityPage />);

    expect(await screen.findByText(baseFlags[0]!.sentence)).toBeTruthy();
    expect(screen.getByText(baseFlags[1]!.sentence)).toBeTruthy();
    expect(screen.getByText('FLAGGED')).toBeTruthy();
    expect(screen.getByText(/newest first/)).toBeTruthy();
  });

  it('NEVER renders the evidence signal tokens — the sentence is the whole interface', async () => {
    mockApi(flagsHandler());
    renderWithQuery(<IntegrityPage />);
    await screen.findByText(baseFlags[0]!.sentence);

    for (const token of [
      'impossible_speed_v1',
      'teleport_jump_v1',
      'payout_link_change_v1',
      '1230',
    ]) {
      expect(screen.queryByText(new RegExp(token))).toBeNull();
    }
  });

  it('refetches with the chosen algorithm and subject filters', async () => {
    const seen: URL[] = [];
    mockApi(flagsHandler(baseFlags, (url) => seen.push(url)));
    const { user } = renderWithQuery(<IntegrityPage />);
    await screen.findByText(baseFlags[0]!.sentence);

    await user.click(screen.getByRole('button', { name: 'ALG-30' }));
    await waitFor(() =>
      expect(seen.some((u) => u.searchParams.get('algo') === 'ALG-30')).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: 'RIDER' }));
    await waitFor(() =>
      expect(seen.some((u) => u.searchParams.get('subjectType') === 'RIDER')).toBe(true),
    );
  });

  it('[L3] the only action is opening the subject — links, never penalty buttons', async () => {
    mockApi(flagsHandler());
    renderWithQuery(<IntegrityPage />);
    await screen.findByText(baseFlags[0]!.sentence);

    const links = screen.getAllByRole('link', { name: 'Open the subject' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/riders/rider-1234567890',
      '/vendors/vendor-987654321',
    ]);

    // Every button on this page is a filter chip. A button that acts on a
    // subject — suspend, block, fine — must never grow here.
    const chipLabels = [
      'All',
      'ALG-15',
      'ALG-30',
      'ALG-34',
      'ORDER',
      'RIDER',
      'DRIVER',
      'VENDOR',
      'CUSTOMER',
      'ITEM',
      '7 days',
      '30 days',
      '90 days',
    ];
    for (const button of screen.getAllByRole('button')) {
      expect(chipLabels).toContain(button.textContent);
    }
  });

  it('renders a 403 as the super-admin guard speaking, not a generic failure', async () => {
    mockApi(() => ({
      status: 403,
      body: { success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } },
    }));
    renderWithQuery(<IntegrityPage />);

    expect(await screen.findByText(/super-admin only/)).toBeTruthy();
  });
});
