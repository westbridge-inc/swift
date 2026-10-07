import { describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';
import { approveVendor, fetchVendorDetail, settleOrderRefund } from '@/lib/api';
import { outcomeOf, succeeded, reviewCenterHref, APPROVALS_HREF } from '@/lib/outcome';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] EVERY SERVER ANSWER, IN PLAIN WORDS, WITH THE NEXT STEP.
//
// Each case below goes through the console's real transport (`apiFetch`, via
// the same helpers the pages call) with the body the API actually sends —
// copied from the server's own code, cited per case — and grades what the
// operator is told. A code never stands alone: it is kept for support, in
// small print, beside a sentence a person can act on.
// ---------------------------------------------------------------------------

const REASON = 'Checked the owner ID and the food licence against the originals';

async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

function replyWith(status: number, body: unknown) {
  return mockApi(() => ({ status, body }));
}

describe('[MC-PR1] 409 CHECKLIST_INCOMPLETE — admin.routes.ts PUT /vendors/:id/approve', () => {
  it('says what to do first, links the Review Center for that applicant, and keeps the server sentence and code', async () => {
    replyWith(409, {
      success: false,
      error: {
        code: 'CHECKLIST_INCOMPLETE',
        message: "Target Store's required documents are not all approved and current — review them in the Verification queue first.",
      },
    });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)), { applicantId: 'usr_owner 1' });
    expect(o.tone).toBe('refused');
    expect(o.title).toBe('Approve the required documents in Verification first');
    expect(o.next).toMatch(/Nothing was changed/);
    expect(o.link).toEqual({ label: 'Open in Review Center', href: '/verification?applicant=usr_owner%201' });
    expect(o.serverMessage).toMatch(/Target Store's required documents/);
    expect(o.code).toBe('CHECKLIST_INCOMPLETE');
    expect(o.status).toBe(409);
  });

  it('without a known applicant, still links the Review Center rather than nowhere', async () => {
    replyWith(409, { success: false, error: { code: 'CHECKLIST_INCOMPLETE', message: 'x' } });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.link?.href).toBe('/verification');
  });
});

describe('[MC-PR1] 202 APPROVAL_REQUIRED — admin.routes.ts two-person gate', () => {
  it('is not a failure: "sent for a second admin", a link to Approvals, the approval id kept', async () => {
    replyWith(202, {
      success: false,
      error: {
        code: 'APPROVAL_REQUIRED',
        message: 'A second admin must approve this before it happens. It is in the approvals queue.',
        details: { approvalId: 'apr_123' },
      },
    });
    const o = outcomeOf(await thrownBy(() => settleOrderRefund('ord_1', 'REF-1001', 500, REASON)));
    expect(o.tone).toBe('queued');
    expect(o.title).toBe("Sent for a second admin's approval");
    expect(o.next).toMatch(/Nothing has changed yet/);
    expect(o.next).toMatch(/do not send it again/i);
    expect(o.link).toEqual({ label: 'Open Approvals', href: APPROVALS_HREF });
    expect(APPROVALS_HREF).toBe('/approvals');
    expect(o.approvalId).toBe('apr_123');
    expect(o.code).toBe('APPROVAL_REQUIRED');
  });

  it('a 202 that is not an approval request is not dressed up as one', async () => {
    replyWith(202, { success: false, error: { code: 'SOMETHING_ELSE', message: 'Odd.' } });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.tone).not.toBe('queued');
  });
});

describe('[MC-PR1] 403 — auth/step-up.ts and the capability gate', () => {
  it('STEP_UP_REQUIRED says to confirm it is you first, and that nothing changed', async () => {
    replyWith(403, {
      success: false,
      error: {
        code: 'STEP_UP_REQUIRED',
        message: 'Confirm it’s you first — we’ll text a code to the phone on this account.',
        details: { stepUp: { send: 'POST /auth/step-up', verify: 'POST /auth/step-up/verify', validForSeconds: 600 } },
      },
    });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.tone).toBe('refused');
    expect(o.title).toBe("Confirm it's you first");
    expect(o.next).toMatch(/one-time code/);
    expect(o.next).toMatch(/Nothing was changed/);
    expect(o.code).toBe('STEP_UP_REQUIRED');
  });

  it('a capability refusal (FORBIDDEN) names the permission problem and keeps the server sentence', async () => {
    replyWith(403, { success: false, error: { code: 'FORBIDDEN', message: 'This admin action requires the vendor.approve capability' } });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.title).toMatch(/permission/i);
    expect(o.serverMessage).toMatch(/vendor\.approve/);
    expect(o.status).toBe(403);
  });
});

describe('[MC-PR1] 400 / 404 / 429', () => {
  it('a reason the gate refused (VALIDATION_ERROR) says fix it and try again', async () => {
    replyWith(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Say why in at least 12 characters — a word is not a reason anyone can review.' } });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.tone).toBe('refused');
    expect(o.next).toMatch(/Nothing was changed/);
    expect(o.serverMessage).toMatch(/at least 12 characters/);
  });

  it('ALREADY_ACTIVE: the store is already live', async () => {
    replyWith(400, { success: false, error: { code: 'ALREADY_ACTIVE', message: 'Vendor is already approved' } });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.title).toBe('This store is already live');
  });

  it('NOT_FOUND on a read says it is gone or outside your market — never "nothing here"', async () => {
    replyWith(404, { success: false, error: { code: 'NOT_FOUND', message: 'Vendor with id vnd_1 not found' } });
    const o = outcomeOf(await thrownBy(() => fetchVendorDetail('vnd_1')), { kind: 'read' });
    expect(o.title).toMatch(/doesn't exist|isn't in your market/);
  });

  it('the global rate limit (code ERROR, status 429) says wait, then try again', async () => {
    replyWith(429, { success: false, error: { code: 'ERROR', message: 'Rate limit exceeded, retry in 1 minute' } });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.title).toMatch(/Too many/);
    expect(o.next).toMatch(/Wait/);
    expect(o.status).toBe(429);
  });
});

describe('[MC-PR1] 503, timeouts and a dropped connection', () => {
  it('503 (plugins/auth.ts AUTH_UNAVAILABLE): Swift cannot do this right now; try again shortly', async () => {
    replyWith(503, {
      success: false,
      error: { code: 'AUTH_UNAVAILABLE', message: 'We could not verify your session right now. Please try again in a moment — you have not been signed out.' },
    });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.tone).toBe('failed');
    expect(o.title).toBe("Swift can't do this right now");
    expect(o.next).toMatch(/Try again in a few minutes/);
    expect(o.code).toBe('AUTH_UNAVAILABLE');
    expect(o.status).toBe(503);
  });

  it('a gateway timeout on a WRITE is uncertain: check before trying again (a blind retry can act twice)', async () => {
    mockApi(() => ({ status: 504, body: '<html>Gateway Timeout</html>' }));
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.tone).toBe('failed');
    expect(o.uncertain).toBe(true);
    expect(o.title).toMatch(/didn't answer in time/);
    expect(o.next).toMatch(/check/i);
  });

  it('a timeout raised in the browser (TimeoutError) reads the same way', () => {
    const o = outcomeOf(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(o.title).toMatch(/didn't answer in time/);
    expect(o.code).toBe('TIMEOUT');
  });

  it('a network failure (fetch rejects) says the server could not be reached, never a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.tone).toBe('failed');
    expect(o.title).toBe("Couldn't reach Swift's server");
    expect(o.uncertain).toBe(true);
    expect(o.code).toBe('NETWORK_ERROR');
    expect(JSON.stringify(o)).not.toMatch(/TypeError|Failed to fetch/);
  });

  it('Safari words the same failure "Load failed" — still a network failure', () => {
    expect(outcomeOf(new TypeError('Load failed')).code).toBe('NETWORK_ERROR');
  });
});

describe('[MC-PR1] success, and the floor for anything unknown', () => {
  it('success is stated in the words the page chose', () => {
    expect(succeeded('Target Store is live.')).toEqual({ tone: 'success', title: 'Target Store is live.' });
  });

  it('an unknown code still gets a sentence and keeps the code; a bare code is never the whole answer', async () => {
    replyWith(409, { success: false, error: { code: 'SOME_NEW_RULE', message: 'The new rule says no.' } });
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.title).not.toMatch(/^[A-Z_]+$/);
    expect(o.title.length).toBeGreaterThan(10);
    expect(o.serverMessage).toBe('The new rule says no.');
    expect(o.code).toBe('SOME_NEW_RULE');
  });

  it('reviewCenterHref encodes the applicant id', () => {
    expect(reviewCenterHref('a/b?c')).toBe('/verification?applicant=a%2Fb%3Fc');
    expect(reviewCenterHref()).toBe('/verification');
  });
});

describe('[MC-PR1] the reason header can always be sent (lib/api.ts)', () => {
  it('iPhone smart punctuation travels as plain punctuation, so the request is actually sent', async () => {
    const fetchMock = mockApi(() => ({ body: { success: true, data: {} } }));
    await approveVendor('vnd_1', 'Owner’s “licence” checked – in person…');
    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['x-swift-reason']).toBe('Owner\'s "licence" checked - in person...');
    expect(() => new Headers(headers)).not.toThrow();
  });

  it('a reason that cannot travel is refused before sending, with a code the outcome layer words', async () => {
    const fetchMock = mockApi(() => ({ body: { success: true, data: {} } }));
    const error = await thrownBy(() => approveVendor('vnd_1', 'Owner confirmed by phone 👍 today'));
    expect(fetchMock).not.toHaveBeenCalled();
    const o = outcomeOf(error);
    expect(o.code).toBe('REASON_UNSENDABLE');
    expect(o.title).toMatch(/can't be sent/);
  });

  it('a session that cannot be refreshed reads "Your session has ended", with a sign-in link', async () => {
    mockApi(() => ({ status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } } }));
    const o = outcomeOf(await thrownBy(() => approveVendor('vnd_1', REASON)));
    expect(o.title).toBe('Your session has ended');
    expect(o.link).toEqual({ label: 'Sign in', href: '/login' });
  });
});
