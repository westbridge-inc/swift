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
  userId: 'target-user',
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
  userId: 'other-user',
  user: {
    ...baseDocument.user,
    firstName: 'Other',
    phone: 'other-phone',
  },
};

// [DS110-14] Approving is itself a reasoned action: the page asks for one
// (12+ chars) and the request must carry it.
const REAL_REASON = 'Insurance policy matches the vehicle and the licence on file';

function verificationHandler(
  mutation: (_request: ApiRequest) => ApiReply | Promise<ApiReply>,
  documents = [baseDocument],
) {
  return (request: ApiRequest) => {
    if (request.url.pathname.endsWith('/queue/counts')) return { body: { data: {} } };
    if (request.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (request.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (request.url.pathname.endsWith('/queue') && request.url.searchParams.get('status') !== 'PENDING') return { body: { data: [] } };
    // [A-19] Approving now requires the evidence to have been OPENED, so every
    // review flow fetches a signed URL first.
    if (request.method === 'GET' && request.url.pathname.endsWith('/document-url')) {
      // [DS110-15] the server returns the render PATH, relative to the API origin
      return {
        body: {
          success: true,
          data: { url: '/api/v1/verification/render/document-target?expires=1&sig=signed' },
        },
      };
    }
    // [DS110-15] the page verifies the load through the same-origin proxy
    // before unlocking the decision
    if (request.method === 'GET' && request.url.pathname === '/api/v1/verification/render/document-target') {
      return { body: { loaded: true } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
      expect(request.url.searchParams.get('status')).toBe('PENDING');
      expect(request.url.searchParams.get('limit')).toBe('50');
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

/**
 * [A-19] What a review now IS: open the evidence, and key the printed expiry
 * when the document type carries one. Approve stays disabled until both.
 */
async function reviewEvidence(user: UserEvent, opts: { expires?: boolean } = {}) {
  vi.stubGlobal('open', vi.fn()); // happy-dom has no real window.open
  await user.click(screen.getByRole('button', { name: /View document/ }));
  const image = await screen.findByRole('img', { name: /evidence/ });
  fireEvent.load(image);
  await screen.findByRole('button', { name: 'View document again' });
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

async function startApproval(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.type(screen.getByLabelText('Decision note'), REAL_REASON);
}
async function startRejection(user: UserEvent, reason = 'Document is unreadable') {
  await user.click(screen.getByRole('button', { name: 'Reject' }));
  await user.type(screen.getByLabelText('Decision note'), reason);
  await user.selectOptions(screen.getByLabelText('Reason code'), 'UNREADABLE');
}

describe('verification mutations', () => {
  it('approves insurance through the exact endpoint with the complete review payload', async () => {
    const insuranceDocument = { ...baseDocument, docType: 'vehicle_insurance' };
    const fetchMock = mockApi(verificationHandler((request) => {
      if (request.method === 'PUT') return { body: { data: { ...insuranceDocument, status: 'APPROVED' } } };
      throw new Error(`Unexpected request: ${request.url}`);
    }, [otherDocument, insuranceDocument]));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await reviewEvidence(user, { expires: true });
    await user.type(screen.getByPlaceholderText(/Insurer/), 'Test Insurer');
    await user.type(screen.getByPlaceholderText('Policy number'), 'POLICY-TEST-1');
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /Hire class confirmed/ }));
    expect(approve.disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /Cross-checked/ }));
    expect(approve.disabled).toBe(false);
    await startApproval(user);
    expect(screen.getByRole('dialog').textContent).toContain('For Target Applicant. This changes their operating eligibility.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    await startApproval(user);
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/verification/document-target/approve`);
    expect(init?.method).toBe('PUT');
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REAL_REASON);
    const future = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    expect(JSON.parse(String(init?.body))).toEqual({
      expiresAt: new Date(future).toISOString(),
      insurance: { insurerName: 'Test Insurer', policyNumber: 'POLICY-TEST-1', coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true },
    });
  });

  it('rejects through the exact endpoint with the entered reason', async () => {
    const fetchMock = mockApi(verificationHandler((request) => {
      if (request.method === 'PUT') return { body: { data: { ...baseDocument, status: 'REJECTED' } } };
      throw new Error(`Unexpected request: ${request.url}`);
    }, [otherDocument, baseDocument]));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await reviewEvidence(user);
    await startRejection(user, '  Document is unreadable  ');
    expect(screen.getByRole('dialog').textContent).toContain('For Target Applicant.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    await startRejection(user, '  Document is unreadable  ');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/verification/document-target/reject`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Document is unreadable', reasonCode: 'UNREADABLE' });
  });

  it.each([
    ['approval', 'Approve', '/api/v1/admin/verification/document-target/approve'],
    ['rejection', 'Reject', '/api/v1/admin/verification/document-target/reject'],
  ])('renders a failed %s honestly and keeps the review open', async (action, buttonName, path) => {
    const fetchMock = mockApi(verificationHandler((request) => {
      if (request.method === 'PUT' && request.url.pathname === path) return { status: 400, body: { success: false, error: { code: 'NOT_PENDING', message: 'Document is APPROVED, only PENDING documents can be reviewed' } } };
      throw new Error(`Unexpected request: ${request.url}`);
    }));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await reviewEvidence(user);
    if (buttonName === 'Reject') await startRejection(user); else await startApproval(user);
    await user.click(screen.getByRole('button', { name: `Confirm ${action}` }));
    expect((await screen.findByRole('alert')).textContent).toContain('Verification action failed: Document is APPROVED, only PENDING documents can be reviewed');
    expect((screen.getByRole('button', { name: `Confirm ${action}` }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('heading', { name: 'Target Applicant' })).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(requestsByMethod(fetchMock, 'GET').filter(([url]) => String(url).includes('/queue?status=PENDING'))).toHaveLength(1);
  });

  it('requires confirmation before approving a document', async () => {
    const fetchMock = mockApi(verificationHandler(() => { throw new Error('No mutation expected'); }));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user); await reviewEvidence(user); await startApproval(user);
    expect(screen.getByRole('dialog').textContent).toContain('Approve National ID');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
  });
  it('requires confirmation before rejecting a document', async () => {
    const fetchMock = mockApi(verificationHandler(() => { throw new Error('No mutation expected'); }));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user); await reviewEvidence(user); await startRejection(user);
    expect(screen.getByRole('dialog').textContent).toContain('Reject National ID');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
  });
  it('blocks a contradictory second decision while the first decision is pending', async () => {
    const pending = deferredReply();
    const fetchMock = mockApi(verificationHandler((request) => {
      if (request.method === 'PUT' && request.url.pathname.endsWith('/approve')) return pending.promise;
      throw new Error(`Unexpected request: ${request.url}`);
    }));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user); await reviewEvidence(user);
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    const reject = screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(false);
    await startApproval(user);
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(approve.disabled).toBe(true); expect(reject.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Saving decision…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reject);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    pending.resolve({ body: { data: { ...baseDocument, status: 'APPROVED' } } });
    await waitFor(() => expect(requestsByMethod(fetchMock, 'GET').filter(([url]) => String(url).includes('/queue?status=PENDING'))).toHaveLength(2));
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
    expect(screen.getByText(/not a review/i)).toBeTruthy();

    await reviewEvidence(user);
    expect(approve().disabled).toBe(false);
  });

  it('a signed-URL failure does not unlock the decision', async () => {
    vi.stubGlobal('alert', vi.fn());
    mockApi((request) => {
      if (request.method === 'GET' && request.url.pathname.endsWith('/document-url')) {
        return { status: 502, body: { success: false, error: { message: 'storage down' } } };
      }
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
        return { body: { success: true, data: [baseDocument] } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    vi.stubGlobal('open', vi.fn());
    await user.click(screen.getByRole('button', { name: /View document/ }));
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

describe('[A-19] the expiring-type list cannot drift from the server', () => {
  it('matches AUTO_APPROVE_EXPIRY_DAYS in the API, key for key', () => {
    const api = readFileSync(
      join(process.cwd(), '../api/src/modules/verification/doc-registry.ts'),
      'utf8',
    );
    const block = /const AUTO_APPROVE_EXPIRY_DAYS: Readonly<Record<string, number>> = \{([\s\S]*?)\};/.exec(api);
    if (!block) throw new Error('AUTO_APPROVE_EXPIRY_DAYS not found in the API document registry');
    const serverTypes = [...block[1]!.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!).sort();
    const page = readFileSync(join(process.cwd(), 'src/app/verification/page.tsx'), 'utf8');
    const local = /const EXPIRING_DOC_TYPES = \[([\s\S]*?)\] as const;/.exec(page);
    if (!local) throw new Error('EXPIRING_DOC_TYPES not found on the page');
    const clientTypes = [...local[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    // the server refuses these without a date; the console must ASK for exactly
    // the same set, or it blocks the wrong documents and lets others through
    // Police clearance derives its re-check from the typed issue date, not a printed expiry.
    const issueTypes = /ISSUE_DATE_DOC_TYPES[^=]*= new Set\(\[([^\]]*)\]\)/.exec(api);
    if (!issueTypes) throw new Error('ISSUE_DATE_DOC_TYPES not found');
    const issued = [...issueTypes[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(clientTypes).toEqual(serverTypes.filter((type) => !issued.includes(type)));
    expect(page).toContain("selected?.reviewerTypes?.includes('issuedOn')");
    expect(page).toContain('Issue date printed on the document');
  });
});

// ---------------------------------------------------------------------------
// [DS110-15] "View document" used to open a RELATIVE URL against the admin
// origin — an instant 404 — and unlock Approve anyway, because `window.open`
// cannot report a failed load. The server now returns an absolute render URL,
// the page verifies it through a same-origin proxy, and the decision unlocks
// only after an actual HTTP 200.
// ---------------------------------------------------------------------------

describe('[DS110-15] the document must actually load before Approve unlocks', () => {
  it('resolves the server’s relative render path and opens it through the admin proxy', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const renderPath = '/api/v1/verification/render/document-target?expires=1&sig=signed';
    mockApi((request) => {
      if (request.method === 'GET' && request.url.pathname.endsWith('/document-url')) {
        return { body: { success: true, data: { url: renderPath } } };
      }
      if (request.method === 'GET' && request.url.pathname === '/api/v1/verification/render/document-target') {
        return { body: { loaded: true } };
      }
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
        return { body: { success: true, data: [baseDocument] } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);

    await user.click(screen.getByRole('button', { name: /View document/ }));
    const preview = await screen.findByRole('img', { name: /evidence/ });
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.load(preview);

    // opened on the ADMIN origin through the proxy — never the bare relative
    // path, which is what 404'd before
    const expected = new URL(renderPath, window.location.origin).toString();
    expect(open).not.toHaveBeenCalled();
    expect(preview.getAttribute('src')).toBe(expected);
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a render failure the proxy reports (410/404) never unlocks the decision', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    vi.stubGlobal('open', vi.fn());
    mockApi((request) => {
      if (request.method === 'GET' && request.url.pathname.endsWith('/document-url')) {
        return {
          body: {
            success: true,
            data: { url: 'http://admin-api.test/api/v1/verification/render/document-target?expires=1&sig=signed' },
          },
        };
      }
      if (request.method === 'GET' && request.url.pathname === '/api/v1/verification/render/document-target') {
        return { status: 410, body: { success: false, error: { code: 'DOCUMENT_PURGED', message: 'gone' } } };
      }
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/verification/queue') {
        return { body: { success: true, data: [baseDocument] } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);

    await user.click(screen.getByRole('button', { name: /View document/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('removed under the retention policy');
    expect(alert).not.toHaveBeenCalled();

    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    // the button never switched to "view again" — nothing was marked previewed
    expect(screen.queryByRole('button', { name: 'View document again' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [ADMIN-CONSOLE] Hosted, this page is where the owner decides real partner
// documents, so it speaks the reject route's whole contract
// (apps/api admin.routes.ts rejectDocSchema): the reviewer's words AND one of
// the server's reason codes. The code is what the applicant is told (a
// category and a consistent opening line) and what the decision record keeps;
// without one the server records the decision as UNSPECIFIED. Two of the
// server's own refusals tell the reviewer to reject AS a code
// (WRONG_PLATE_CLASS, INSURANCE_NOT_HIRE), and the fraud class only reaches a
// second reviewer when it is sent as a code. The codes are read from the API
// source, so the page cannot drift from what the route accepts.
// ---------------------------------------------------------------------------

function apiSource(path: string): string {
  return readFileSync(join(process.cwd(), '../api/src', path), 'utf8');
}

function serverCodes(name: 'REJECTION_REASON_CODES' | 'RETIRED_REJECTION_REASON_CODES'): string[] {
  const block = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(
    apiSource('modules/verification/verification.service.ts'),
  );
  if (!block) throw new Error(`${name} not found in the API verification service`);
  return [...block[1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
}

function serverSecondReviewCodes(): string[] {
  const block = /FRAUD_CLASS_CODES[^=]*= new Set<RejectionReasonCode>\(\[([^\]]*)\]\)/.exec(
    apiSource('modules/verification/verification.service.ts'),
  );
  if (!block) throw new Error('FRAUD_CLASS_CODES not found in the API verification service');
  return [...block[1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
}

function serverRejectBodyKeys(): string[] {
  const block = /const rejectDocSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(apiSource('modules/admin/admin.routes.ts'));
  if (!block) throw new Error('rejectDocSchema not found in the admin routes');
  return [...block[1]!.matchAll(/^\s*([a-zA-Z]+):/gm)].map((m) => m[1]!).sort();
}

const PLATE_REASON = 'The registration on the photo is a private P plate, not an H plate';

describe('[ADMIN-CONSOLE] a rejection carries one of the server’s reason codes', () => {
  it('offers exactly the server’s live codes, in its order: the H-plate reason, never the retired colour one', async () => {
    mockApi(verificationHandler(() => { throw new Error('no mutation expected'); }));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const offered = within(screen.getByLabelText('Reason code'))
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean);
    expect(offered).toEqual(serverCodes('REJECTION_REASON_CODES'));
    expect(offered).toContain('WRONG_PLATE_CLASS');
    // [#1415] the owner's ruling retired the colour reason; the route refuses it
    expect(serverCodes('RETIRED_REJECTION_REASON_CODES')).toContain('NOT_YELLOW');
    for (const retired of serverCodes('RETIRED_REJECTION_REASON_CODES')) expect(offered).not.toContain(retired);
  });

  it('says a code goes to a second reviewer for exactly the server’s fraud class', async () => {
    mockApi(verificationHandler(() => { throw new Error('no mutation expected'); }));
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const warned: string[] = [];
    for (const code of serverCodes('REJECTION_REASON_CODES')) {
      await user.selectOptions(screen.getByLabelText('Reason code'), code);
      if (screen.queryByText(/a different reviewer must confirm/i)) warned.push(code);
    }
    expect(warned.sort()).toEqual(serverSecondReviewCodes());
  });

  it('reject stays shut until a code is chosen, then sends the code with the reviewer’s words, the route’s whole body', async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/verification/document-target/reject') {
          return { body: { success: true, data: { ...baseDocument, status: 'REJECTED' } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await reviewEvidence(user);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.type(screen.getByPlaceholderText('Rejection reason'), PLATE_REASON);
    const rejectButton = screen.getByRole('button', { name: 'Confirm rejection' }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(true);

    await user.selectOptions(screen.getByLabelText('Reason code'), 'WRONG_PLATE_CLASS');
    expect(rejectButton.disabled).toBe(false);
    await user.click(rejectButton);

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual({ reason: PLATE_REASON, reasonCode: 'WRONG_PLATE_CLASS' });
    expect(Object.keys(sent).sort()).toEqual(serverRejectBodyKeys());
    // [ADM-006] the stated reason rides the header the server reads first
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(PLATE_REASON);
    expect(screen.queryByText(/second review/i)).toBeNull();
  });

  it('a second-reviewer code says so before sending, and the page never calls the document rejected', async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
    mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/verification/document-target/reject') {
          // [DOC-1 §24.2] the first reviewer's suspicion escalates: the document stays PENDING
          return { body: { success: true, data: { ...baseDocument, status: 'PENDING' } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await reviewEvidence(user);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.type(screen.getByPlaceholderText('Rejection reason'), 'The edges of the photo look edited around the name');
    await user.selectOptions(screen.getByLabelText('Reason code'), 'SUSPECTED_TAMPERING');
    expect(screen.getByText(/a different reviewer must confirm/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));

    expect(confirm).not.toHaveBeenCalled();
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/sent for a second review/i);
    expect(notice.textContent).toMatch(/not rejected/i);
  });

  it('the server’s second-reviewer rule is shown in the server’s own words', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const refusal = 'You raised this suspicion — a different reviewer must confirm it (DOC-1 §24.2)';
    mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/verification/document-target/reject') {
          return { status: 403, body: { success: false, error: { code: 'SECOND_REVIEWER_REQUIRED', message: refusal } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await reviewEvidence(user);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.type(screen.getByPlaceholderText('Rejection reason'), 'The photo was clearly edited around the name');
    await user.selectOptions(screen.getByLabelText('Reason code'), 'SUSPECTED_TAMPERING');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));

    expect((await screen.findByRole('alert')).textContent).toContain(refusal);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an approval the server refuses for its plate is shown, and the reviewer rejects with that code', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.stubGlobal('prompt', vi.fn().mockReturnValue(REAL_REASON));
    const plateRefusal = 'A taxi must carry an H registration mark; this vehicle is registered as P 1234. Reject the document as WRONG_PLATE_CLASS.';
    const fetchMock = mockApi(
      verificationHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/verification/document-target/approve') {
          return { status: 400, body: { success: false, error: { code: 'WRONG_PLATE_CLASS', message: plateRefusal } } };
        }
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/verification/document-target/reject') {
          return { body: { success: true, data: { ...baseDocument, status: 'REJECTED' } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<VerificationPage />);
    await openReview(user);
    await reviewEvidence(user);
    await startApproval(user);
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    expect((await screen.findByRole('alert')).textContent).toContain(plateRefusal);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.type(screen.getByPlaceholderText('Rejection reason'), PLATE_REASON);
    await user.selectOptions(screen.getByLabelText('Reason code'), 'WRONG_PLATE_CLASS');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(2));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'PUT')[1]![1]?.body)).reasonCode).toBe('WRONG_PLATE_CLASS');
  });
});
