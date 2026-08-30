import { screen, waitFor, within } from '@testing-library/react';
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
};

const otherDocument = {
  ...baseDocument,
  id: 'document-other',
  user: {
    ...baseDocument.user,
    firstName: 'Other',
    phone: 'other-phone',
  },
};

function verificationHandler(
  mutation: (_request: ApiRequest) => ApiReply | Promise<ApiReply>,
  documents = [baseDocument],
) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
      expect(request.url.searchParams.get('status')).toBe('PENDING');
      expect(request.url.searchParams.get('limit')).toBe('100');
      // [G6] every test in this file works the routine queue — the operator lane.
      expect(request.url.searchParams.get('role')).toBe('operator');
      return { body: { success: true, data: documents } };
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
    expect(JSON.parse(String(init?.body))).toEqual({
      insurance: {
        insurerName: 'Test Insurer',
        policyNumber: 'POLICY-TEST-1',
        coverageClass: 'HIRE',
        hireClassConfirmed: true,
        plateCrossChecked: true,
      },
    });
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
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Document is unreadable' });
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
    if (buttonName === 'Reject') {
      await user.type(screen.getByPlaceholderText('Rejection reason'), 'Document is unreadable');
    }
    await user.click(screen.getByRole('button', { name: buttonName }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Verification action failed: Document is APPROVED, only PENDING documents can be reviewed',
    );
    expect((screen.getByRole('button', { name: buttonName }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByText('target-phone')).not.toHaveLength(0);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(1);
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
    await waitFor(() => expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(2));
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
