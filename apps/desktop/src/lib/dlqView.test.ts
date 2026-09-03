import { describe, it, expect } from 'vitest';
import {
  acknowledgementPrompt, failureSummary, payloadSummary, replayVerdict, type DeadJob,
} from './dlqView';

// ---------------------------------------------------------------------------
// [D-12] A DEAD JOB IS NOT A BUTTON, AND ITS PAYLOAD IS NOT A CAPTION.
//
// The health screen offered "Requeue" identically on all 53 job classes — and
// the API refuses 45 of them (A-08's certified recovery matrix), sending its
// verdict with every dead job. The page ignored it. An operator clicked, and
// got a 409 explaining what the page could have told them; worse, the offer
// itself read as "this platform believes retrying is safe".
//
// And it printed the payload: `<p className="truncate">{j.data}</p>`. Truncate
// is CSS. The whole string — a phone number, a delivery address, a payer
// reference — was in the DOM, selectable, copyable, and in every screenshot of
// the page.
// ---------------------------------------------------------------------------

const job = (over: Partial<DeadJob> = {}): DeadJob => ({
  queue: 'order', id: '42', name: 'auto-cancel', ...over,
});

describe('[D-12] the button says what the server will actually do', () => {
  it('a certified class is offered plainly', () => {
    const v = replayVerdict(job({ recovery: { policy: 'SAFE_REPLAY', why: 'reads only' } }));
    expect(v).toMatchObject({ offered: true, needsAcknowledgement: false, label: 'Requeue' });
  });

  it('a class that may have half-finished asks the operator to reconcile FIRST', () => {
    const v = replayVerdict(job({ recovery: { policy: 'RECONCILE_FIRST', why: 'it may have paid out already' } }));
    expect(v.offered).toBe(true);
    expect(v.needsAcknowledgement).toBe(true);
    expect(v.label).toMatch(/Reconcile/);
    expect(acknowledgementPrompt(job(), v)).toMatch(/already happened does it twice/);
    expect(acknowledgementPrompt(job(), v)).toContain('it may have paid out already');
  });

  it('an uncertified class is NOT offered — the defect was one identical button on all 53', () => {
    const v = replayVerdict(job({ recovery: { policy: 'NOT_CERTIFIED', why: 'nobody has proven this is idempotent' } }));
    expect(v.offered).toBe(false);
    expect(v.label).toBe('Cannot be replayed');
    expect(v.why).toContain('nobody has proven this is idempotent');
  });

  it('a job that arrives with NO classification is refused, not assumed safe', () => {
    for (const recovery of [undefined, null, {}, { policy: 'MAYBE' }, { policy: 42 }]) {
      const v = replayVerdict(job({ recovery: recovery as never }));
      expect(v.policy, JSON.stringify(recovery)).toBe('NOT_CERTIFIED');
      expect(v.offered).toBe(false);
    }
  });

  it("the reason shown is the server's own words — this console never invents one", () => {
    const why = 'the settlement may already have been posted';
    expect(replayVerdict(job({ recovery: { policy: 'NOT_CERTIFIED', why } })).why).toBe(why);
  });
});

describe('[D-12] the payload is summarised, never printed', () => {
  it('a phone, an address and a token never reach the screen', () => {
    const summary = payloadSummary(JSON.stringify({
      orderId: 'ord_123',
      customerPhone: '+592 600 1234',
      deliveryAddress: '12 Lamaha Street, Georgetown',
      // a token-SHAPED opaque string; deliberately not a real provider's
      // prefix, because the secret gate rightly flags those even in a fixture
      providerToken: 'OPAQUEFIXTUREVALUE0123456789',
      attempts: 3,
    }));
    expect(summary).not.toContain('592');
    expect(summary).not.toContain('Lamaha');
    expect(summary).not.toContain('OPAQUEFIXTUREVALUE');
    // and it is still useful: the keys and the id an operator searches by
    expect(summary).toContain('orderId: ord_123');
    expect(summary).toContain('customerPhone: «redacted»');
    expect(summary).toContain('providerToken: «redacted»');
  });

  it('a sensitive VALUE under an innocent key is caught by shape, not by name', () => {
    const summary = payloadSummary(JSON.stringify({ x: '+5926001234', y: 'ops@swift.gy', z: 'A'.repeat(30) }));
    expect(summary).toContain('x: «phone»');
    expect(summary).toContain('y: «email»');
    expect(summary).toContain('z: «token»');
  });

  it('an unreadable or non-object payload is not echoed — that is exactly when nobody knows what is in it', () => {
    expect(payloadSummary('{not json')).toBe('(payload not readable — not shown)');
    expect(payloadSummary('"a bare string"')).toBe('(payload not an object — not shown)');
    expect(payloadSummary(JSON.stringify(['a', 'b']))).toBe('(payload not an object — not shown)');
    expect(payloadSummary(null)).toBe('(no payload)');
    expect(payloadSummary('')).toBe('(no payload)');
    expect(payloadSummary('{}')).toBe('(empty payload)');
  });

  it('nested structures are shown as shapes, not walked into', () => {
    const summary = payloadSummary(JSON.stringify({ order: { phone: '+5926001234' }, ids: ['a', 'b', 'c'] }));
    expect(summary).toBe('order: {…} · ids: [3]');
    expect(summary).not.toContain('5926001234');
  });

  it('a coordinate is redacted — a live location is not triage information', () => {
    expect(payloadSummary(JSON.stringify({ lat: 6.8013, lng: -58.1551 }))).toBe('lat: «redacted» · lng: «redacted»');
  });
});

describe('[D-12] the failure text is scrubbed too', () => {
  it('an error message quoting the data it choked on does not leak it', () => {
    const scrubbed = failureSummary('Invalid phone +592 600 1234 for ops@swift.gy');
    expect(scrubbed).not.toContain('592');
    expect(scrubbed).not.toContain('ops@swift.gy');
    expect(scrubbed).toContain('«phone»');
    expect(scrubbed).toContain('«email»');
  });

  it('an absent reason stays absent, and a huge one is cut', () => {
    expect(failureSummary(null)).toBeNull();
    expect(failureSummary('   ')).toBeNull();
    expect(failureSummary('x'.repeat(500))!.length).toBeLessThanOrEqual(301);
  });
});
