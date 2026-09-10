import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import VerificationPage from './page';
import {
  API_ORIGIN,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiReply,
  type ApiRequest,
} from '@/test/test-utils';

const baseDocument = {
  id: 'document-target',
  status: 'PENDING',
  docType: 'national_id',
  role: 'RIDER',
  consentAt: '2026-08-01T00:00:00.000Z',
  privacyNoticeVersion: 'test-v1',
  user: {
    firstName: 'Target',
    lastName: 'Applicant',
    phone: 'target-phone',
    countryCode: 'GY',
  },
  reviewCase: {
    id: 'case-target',
    queue: 'STANDARD',
    priority: 100,
    assignedAt: '2026-09-09T20:00:00.000Z',
    claimedByMe: true,
  },
};

const otherDocument = {
  ...baseDocument,
  id: 'document-other',
  user: {
    ...baseDocument.user,
    firstName: 'Other',
    phone: 'other-phone',
  },
  reviewCase: {
    ...baseDocument.reviewCase,
    id: 'case-other',
  },
};

function verificationHandler(
  mutation: (_request: ApiRequest) => ApiReply | Promise<ApiReply>,
  documents: any[] = [baseDocument],
  intercept?: (_request: ApiRequest) => ApiReply | Promise<ApiReply> | undefined,
) {
  return (request: ApiRequest) => {
    const intercepted = intercept?.(request);
    if (intercepted !== undefined) return intercepted;
    // [A-19] Approving now requires the evidence to have been OPENED, so every
    // review flow fetches a signed URL first.
    if (request.method === 'GET' && request.url.pathname.endsWith('/document-url')) {
      const id = request.url.pathname.split('/').at(-2) ?? 'document-target';
      return { body: { success: true, data: {
        url: `/api/v1/admin/verification/${id}/render`,
        mimeType: 'image/jpeg',
        expiresInSeconds: 300,
        reviewGrantToken: `review-grant-token-${id}-000000000000`,
      } } };
    }
    if (request.method === 'GET' && request.url.pathname.endsWith('/render')) {
      // The viewer consumes protected image bytes through an authenticated fetch
      // and renders its Blob URL, rather than putting a render URL in <img src>.
      return { body: new Uint8Array([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08,
        0x00, 0x20, 0x00, 0x20,
      ]) };
    }
    if (request.method === 'POST' && request.url.pathname.endsWith('/render-ack')) {
      return { body: { success: true, data: { acknowledged: true } } };
    }
    if (request.method === 'GET' && request.url.pathname.endsWith('/review-detail')) {
      const id = request.url.pathname.split('/').at(-2);
      const document = documents.find((candidate) => candidate.id === id) ?? documents[0]!;
      return { body: { success: true, data: {
        document: {
          consentAt: document.consentAt,
          privacyNoticeVersion: document.privacyNoticeVersion,
        },
        applicant: document.user,
        extraction: [], validations: [], missingDeclaredFields: [], cases: [],
      } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
      expect(request.url.searchParams.get('status')).toBe('PENDING');
      expect(request.url.searchParams.get('limit')).toBe('25');
      expect(request.url.searchParams.get('page')).toBe('1');
      // [G6] every test in this file works the routine queue — the operator lane.
      expect(request.url.searchParams.get('role')).toBe('operator');
      // Model the real minimized queue: phone, vehicle, consent and privacy
      // fields arrive only from the claimed sensitive-detail endpoint above.
      const queueDocuments = documents.map(({ consentAt: _consentAt, privacyNoticeVersion: _notice, ...document }) => {
        const { phone: _phone, driver: _driver, ...user } = document.user as typeof document.user & {
          phone?: string;
          driver?: unknown;
        };
        return { ...document, user };
      });
      return { body: { success: true, data: queueDocuments } };
    }
    return mutation(request);
  };
}

async function openReview(
  user: ReturnType<typeof renderWithQuery>['user'],
  applicant = 'Target Applicant',
) {
  const applicantCell = await screen.findByText(applicant);
  const row = applicantCell.closest('tr');
  if (!row) throw new Error(`No verification row found for ${applicant}`);
  await user.click(within(row).getByRole('button', { name: 'Review' }));
}

/**
 * [A-19] What a review now IS: open the evidence, and key the printed expiry
 * when the document type carries one. Approve stays disabled until both.
 */
async function reviewEvidence(user: UserEvent, opts: { expires?: boolean } = {}) {
  await user.click(screen.getByRole('button', { name: /Open secure document viewer/ }));
  const image = await screen.findByRole('img');
  fireEvent.load(image);
  await waitFor(() => expect(screen.queryByText(/current session-, case-, assignment-/i)).toBeNull());
  await user.type(
    screen.getByPlaceholderText(/State what you checked/),
    'Source details match the submitted application',
  );
  await user.selectOptions(screen.getByRole('combobox', { name: 'Rejection category' }), 'UNREADABLE');
  if (opts.expires) {
    const future = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const input = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: future } });
  }
}

function deferredReply() {
  let resolve!: (_reply: ApiReply) => void;
  const promise = new Promise<ApiReply>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('verification mutations', () => {
  it('approves insurance through the exact endpoint with the complete review payload', async () => {
    const insuranceDocument = { ...baseDocument, docType: 'vehicle_insurance' };
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/verification/document-target/approve') {
          return { body: { success: true, data: {} } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }, [otherDocument, insuranceDocument]),
    );
    const { user } = renderWithQuery(<VerificationPage />);

    await openReview(user);
    // [A-19] vehicle insurance carries a printed expiry, so a reviewer keys it
    await reviewEvidence(user, { expires: true });
    await user.type(screen.getByPlaceholderText(/Insurer/), 'Test Insurer');
    await user.type(screen.getByPlaceholderText('Policy number'), 'POLICY-TEST-1');
    const approveButton = screen.getByRole('button', { name: 'Approve' });
    expect((approveButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /Hire class confirmed/ }));
    expect((approveButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /Cross-checked/ }));
    expect((approveButton as HTMLButtonElement).disabled).toBe(false);

    await user.click(approveButton);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'Approve vehicle insurance for Target Applicant? This changes their operating eligibility.',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(approveButton);

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Approve vehicle insurance for Target Applicant? This changes their operating eligibility.',
    );
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/verification/document-target/approve`);
    expect(init?.method).toBe('PUT');
    const sent = JSON.parse(String(init?.body));
    expect(sent.insurance).toEqual({
      insurerName: 'Test Insurer',
      policyNumber: 'POLICY-TEST-1',
      coverageClass: 'HIRE',
      hireClassConfirmed: true,
      plateCrossChecked: true,
    });
    expect(sent.reason).toBe('Source details match the submitted application');
    expect(sent.reviewGrantToken).toBe('review-grant-token-document-target-000000000000');
    // [A-19] and the printed expiry the reviewer keyed rides with it — without
    // it the server refuses, and an approved policy would never lapse.
    expect(typeof sent.expiresAt).toBe('string');
    expect(new Date(sent.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects through the exact endpoint with the entered reason', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/verification/document-target/reject') {
          return { body: { success: true, data: {} } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }, [otherDocument, baseDocument]),
    );
    const { user } = renderWithQuery(<VerificationPage />);

    await openReview(user);
    await reviewEvidence(user);
    await user.type(screen.getByPlaceholderText('Rejection reason'), '  Document is unreadable  ');
    const rejectButton = screen.getByRole('button', { name: 'Reject' });

    await user.click(rejectButton);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'Reject national id for Target Applicant with reason: "Document is unreadable"?',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(rejectButton);

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Reject national id for Target Applicant with reason: "Document is unreadable"?',
    );
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/verification/document-target/reject`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: 'Document is unreadable',
      reasonCode: 'UNREADABLE',
      reviewGrantToken: 'review-grant-token-document-target-000000000000',
    });
  });

  it.each([
    ['approval', 'Approve', '/api/v1/admin/verification/document-target/approve'],
    ['rejection', 'Reject', '/api/v1/admin/verification/document-target/reject'],
  ])('renders a failed %s honestly and keeps the review open', async (_action, buttonName, path) => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const fetchMock = mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === path) {
          return {
            status: 400,
            body: {
              success: false,
              error: {
                code: 'NOT_PENDING',
                message: 'Document is APPROVED, only PENDING documents can be reviewed',
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<VerificationPage />);

    await openReview(user);
    await reviewEvidence(user);
    if (buttonName === 'Reject') {
      await user.type(screen.getByPlaceholderText('Rejection reason'), 'Document is unreadable');
    }
    await user.click(screen.getByRole('button', { name: buttonName }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Verification action failed: Document is APPROVED, only PENDING documents can be reviewed',
    );
    expect((screen.getByRole('button', { name: buttonName }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/target-phone/)).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    // one QUEUE read (the signed-URL evidence read is also a GET now)
    expect(requestsByMethod(fetchMock, 'GET').filter(([url]) => String(url).includes('/queue'))).toHaveLength(1);
  });

  it('requires confirmation before approving a document', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT') return { body: { success: true, data: {} } };
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<VerificationPage />);

    await openReview(user);
    await reviewEvidence(user);
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(confirm).toHaveBeenCalledWith(
      'Approve national id for Target Applicant? This changes their operating eligibility.',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
  });

  it('requires confirmation before rejecting a document', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT') return { body: { success: true, data: {} } };
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<VerificationPage />);

    await openReview(user);
    await reviewEvidence(user);
    await user.type(screen.getByPlaceholderText('Rejection reason'), 'Document is unreadable');
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    expect(confirm).toHaveBeenCalledWith(
      'Reject national id for Target Applicant with reason: "Document is unreadable"?',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
  });

  it('blocks a contradictory second decision while the first decision is pending', async () => {
    const pending = deferredReply();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const fetchMock = mockApi(
      verificationHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/verification/document-target/approve'
        ) {
          return pending.promise;
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<VerificationPage />);

    await openReview(user);
    await reviewEvidence(user);
    await user.type(screen.getByPlaceholderText('Rejection reason'), 'Document is unreadable');
    const approveButton = screen.getByRole('button', { name: 'Approve' });
    const rejectButton = screen.getByRole('button', { name: 'Reject' });

    await user.click(approveButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect((approveButton as HTMLButtonElement).disabled).toBe(true);
    expect((rejectButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(rejectButton);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);

    pending.resolve({ body: { success: true, data: {} } });
    await waitFor(() => expect(
      requestsByMethod(fetchMock, 'GET').filter(([url]) => String(url).includes('/verification/queue')),
    ).toHaveLength(2));
  });
});

describe('verification lanes [G6]', () => {
  it('defaults to the operator lane; the customer lane is asked for by name', async () => {
    const seen: string[] = [];
    mockApi((request: ApiRequest) => {
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
        seen.push(request.url.searchParams.get('role') ?? '(none)');
        return { body: { success: true, data: [baseDocument] } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<VerificationPage />);

    await screen.findByText('Target Applicant');
    // The default view carries no customer identity — the wire says so.
    expect(seen).toEqual(['operator']);

    await user.click(screen.getByRole('button', { name: 'Customers' }));
    await waitFor(() => expect(seen).toEqual(['operator', 'customer']));

    await user.click(screen.getByRole('button', { name: 'Everything' }));
    await waitFor(() => expect(seen).toEqual(['operator', 'customer', 'all']));
  });
});

// ---------------------------------------------------------------------------
// [A-19] S0 compliance. Two ways this console produced a "false green":
//
//  1. A failed queue read rendered "No documents" — an EMPTY compliance queue,
//     shown to the person whose job is to work it.
//  2. Approve was live from the moment a row was selected. The operator could
//     approve identity and vehicle documents without ever opening them, and
//     without keying the printed expiry — so a licence or insurance policy
//     became permanently valid.
//
// A checkbox also asserted "cross-checked against the H-plate" while the plate
// was never sent to the page at all.
// ---------------------------------------------------------------------------

describe('[A-19] a decision requires the evidence', () => {
  it('a failed queue read is not an empty queue', async () => {
    mockApi((request) => {
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
        return { status: 500, body: { success: false, error: { message: 'upstream down' } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    renderWithQuery(<VerificationPage />);
    expect(await screen.findByText(/could not read it/i)).toBeTruthy();
    expect(screen.queryByText('No documents')).toBeNull();
  });

  it('approve is dead until the document has actually been opened', async () => {
    mockApi(verificationHandler(() => { throw new Error('no mutation expected'); }));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);

    const approve = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve().disabled).toBe(true);
    expect(screen.getByText(/current session-, case-, assignment-/i)).toBeTruthy();

    await reviewEvidence(user);
    expect(approve().disabled).toBe(false);
  });

  it('keeps both decisions locked until the render acknowledgement commits', async () => {
    const acknowledgement = deferredReply();
    const fetchMock = mockApi(verificationHandler(
      () => { throw new Error('no mutation expected'); },
      [baseDocument],
      (request) => request.method === 'POST' && request.url.pathname.endsWith('/render-ack')
        ? acknowledgement.promise
        : undefined,
    ));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await user.type(
      screen.getByPlaceholderText(/State what you checked/),
      'Source details match the submitted application',
    );
    await user.type(screen.getByPlaceholderText('Rejection reason'), 'Document is unreadable');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Rejection category' }), 'UNREADABLE');
    await user.click(screen.getByRole('button', { name: /Open secure document viewer/ }));
    fireEvent.load(await screen.findByRole('img'));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));

    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true);

    acknowledgement.resolve({ body: { success: true, data: { acknowledged: true } } });
    await waitFor(() => expect(
      (screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled,
    ).toBe(false));
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not permit a decision when render acknowledgement fails', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const fetchMock = mockApi(verificationHandler(
      (request) => {
        if (request.method === 'PUT') return { body: { success: true, data: {} } };
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      },
      [baseDocument],
      (request) => request.method === 'POST' && request.url.pathname.endsWith('/render-ack')
        ? { status: 500, body: { success: false, error: { code: 'AUDIT_WRITE_FAILED', message: 'audit unavailable' } } }
        : undefined,
    ));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await user.type(
      screen.getByPlaceholderText(/State what you checked/),
      'Source details match the submitted application',
    );
    await user.click(screen.getByRole('button', { name: /Open secure document viewer/ }));
    fireEvent.load(await screen.findByRole('img'));
    expect((await screen.findByRole('alert')).textContent).toContain('audit unavailable');

    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await user.click(approve);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
  });

  it('drops a delayed grant for A after the reviewer selects B', async () => {
    const mint = deferredReply();
    mockApi(verificationHandler(
      () => { throw new Error('no mutation expected'); },
      [baseDocument, otherDocument],
      (request) => request.method === 'GET'
        && request.url.pathname === '/api/v1/admin/verification/document-target/document-url'
        ? mint.promise
        : undefined,
    ));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await user.click(screen.getByRole('button', { name: /Open secure document viewer/ }));
    await openReview(user, 'Other Applicant');
    mint.resolve({ body: { success: true, data: {
      url: '/api/v1/admin/verification/document-target/render',
      mimeType: 'image/jpeg',
      expiresInSeconds: 300,
      reviewGrantToken: 'review-grant-token-delayed-target-00001',
    } } });

    await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/other-phone/)).toBeTruthy();
  });

  it('does not credit a delayed acknowledgement for A to selected document B', async () => {
    const acknowledgement = deferredReply();
    mockApi(verificationHandler(
      () => { throw new Error('no mutation expected'); },
      [baseDocument, otherDocument],
      (request) => request.method === 'POST'
        && request.url.pathname === '/api/v1/admin/verification/document-target/render-ack'
        ? acknowledgement.promise
        : undefined,
    ));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await user.click(screen.getByRole('button', { name: /Open secure document viewer/ }));
    fireEvent.load(await screen.findByRole('img'));
    await openReview(user, 'Other Applicant');
    acknowledgement.resolve({ body: { success: true, data: { acknowledged: true } } });

    await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/other-phone/)).toBeTruthy();
  });

  it('a signed-URL failure does not unlock the decision', async () => {
    vi.stubGlobal('alert', vi.fn());
    mockApi((request) => {
      if (request.method === 'GET' && request.url.pathname.endsWith('/document-url')) {
        return { status: 502, body: { success: false, error: { message: 'storage down' } } };
      }
      if (request.method === 'GET' && request.url.pathname.endsWith('/review-detail')) {
        return { body: { success: true, data: { extraction: [], validations: [], missingDeclaredFields: [], cases: [] } } };
      }
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
        return { body: { success: true, data: [baseDocument] } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await user.click(screen.getByRole('button', { name: /Open secure document viewer/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    // the preview FAILED, so the decision stays locked
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an expiring document cannot be approved without its printed date', async () => {
    const insuranceDocument = { ...baseDocument, docType: 'vehicle_insurance' };
    mockApi(verificationHandler(() => { throw new Error('no mutation expected'); }, [insuranceDocument]));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await reviewEvidence(user);            // opened, but no date keyed
    await user.type(screen.getByPlaceholderText(/Insurer/), 'Test Insurer');
    await user.type(screen.getByPlaceholderText('Policy number'), 'POLICY-TEST-1');
    await user.click(screen.getByRole('checkbox', { name: /Hire class confirmed/ }));
    await user.click(screen.getByRole('checkbox', { name: /Cross-checked/ }));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/key the date from the document/i)).toBeTruthy();

    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: past } });
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/already passed/i)).toBeTruthy();
  });

  it('the plate the reviewer is asked to cross-check is on the screen', async () => {
    const withVehicle = {
      ...baseDocument,
      docType: 'vehicle_insurance',
      user: { ...baseDocument.user, driver: { licensePlate: 'HB 4210', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleType: 'CAR' } },
    };
    mockApi(verificationHandler(() => { throw new Error('no mutation expected'); }, [withVehicle]));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    expect(screen.getByText('HB 4210')).toBeTruthy();
    expect(screen.getByText(/Toyota/)).toBeTruthy();
  });
});

describe('review-case selection races and sensitive-detail lifetime', () => {
  it('does not apply a delayed claim for A to selected document B', async () => {
    const claim = deferredReply();
    const unclaimed = (document: typeof baseDocument) => ({
      ...document,
      reviewCase: { ...document.reviewCase, assignedAt: null, claimedByMe: false },
    });
    const target = unclaimed(baseDocument);
    const other = unclaimed(otherDocument);
    mockApi(verificationHandler(
      () => { throw new Error('no unexpected request'); },
      [target, other],
      (request) => request.method === 'POST' && request.url.pathname === '/api/v1/admin/verification/cases/case-target/claim'
        ? claim.promise
        : undefined,
    ));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await user.click(screen.getByRole('button', { name: 'Claim case' }));
    await openReview(user, 'Other Applicant');
    claim.resolve({ body: { success: true, data: {
      id: 'case-target', assignedAt: '2026-09-09T20:05:00.000Z', assignedTo: 'reviewer',
    } } });

    await waitFor(() => expect((screen.getByRole('button', { name: 'Claim case' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  it('does not apply a delayed release for A to selected document B', async () => {
    const release = deferredReply();
    mockApi(verificationHandler(
      () => { throw new Error('no unexpected request'); },
      [baseDocument, otherDocument],
      (request) => request.method === 'POST' && request.url.pathname === '/api/v1/admin/verification/cases/case-target/release'
        ? release.promise
        : undefined,
    ));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await user.click(screen.getByRole('button', { name: 'Release' }));
    await openReview(user, 'Other Applicant');
    release.resolve({ body: { success: true, data: {} } });

    await waitFor(() => expect((screen.getByRole('button', { name: 'Release' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Claim case' })).toBeNull();
    expect(screen.getByText(/other-phone/)).toBeTruthy();
  });

  it('removes claimed-only PII and vehicle evidence immediately on release', async () => {
    const withVehicle = {
      ...baseDocument,
      consentAt: '2026-08-01T00:00:00.000Z',
      user: {
        ...baseDocument.user,
        phone: 'target-phone',
        driver: { licensePlate: 'HB 4210', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleType: 'CAR' },
      },
    };
    mockApi(verificationHandler(
      (request) => request.method === 'POST' && request.url.pathname.endsWith('/release')
        ? { body: { success: true, data: {} } }
        : Promise.reject(new Error(`Unexpected request: ${request.method} ${request.url}`)),
      [withVehicle],
    ));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    expect(await screen.findByText(/target-phone/)).toBeTruthy();
    expect(screen.getByText('HB 4210')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Release' }));

    await waitFor(() => expect(screen.queryByText(/target-phone/)).toBeNull());
    expect(screen.queryByText('HB 4210')).toBeNull();
    expect(screen.getByText(/Phone withheld until the claimed detail loads/)).toBeTruthy();
    expect(screen.getByText(/available after claim/)).toBeTruthy();
  });
});

describe('[A-19] the expiring-type list cannot drift from the server', () => {
  it('matches AUTO_APPROVE_EXPIRY_DAYS in the API, key for key', () => {
    const api = readFileSync(
      join(process.cwd(), '../api/src/modules/verification/verification.service.ts'),
      'utf8',
    );
    const block = /const AUTO_APPROVE_EXPIRY_DAYS: Record<string, number> = \{([\s\S]*?)\};/.exec(api);
    if (!block) throw new Error('AUTO_APPROVE_EXPIRY_DAYS not found in the API service');
    const serverTypes = [...block[1]!.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!).sort();
    const page = readFileSync(join(process.cwd(), 'src/app/verification/page.tsx'), 'utf8');
    const local = /const EXPIRING_DOC_TYPES = \[([\s\S]*?)\] as const;/.exec(page);
    if (!local) throw new Error('EXPIRING_DOC_TYPES not found on the page');
    const clientTypes = [...local[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    // the server refuses these without a date; the console must ASK for exactly
    // the same set, or it blocks the wrong documents and lets others through
    expect(clientTypes).toEqual(serverTypes);
  });
});
