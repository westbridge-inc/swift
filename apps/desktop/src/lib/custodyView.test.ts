import { describe, it, expect } from 'vitest';
import { custodySummary, proofLists, timelineLines, type CustodyNarrative } from './custodyView';

const n: CustodyNarrative = {
  submission: { id: 'd1', docType: 'food_handler_cert', role: 'VENDOR_OWNER', accountId: 'acc1', subjectId: null, state: 'COMMITTED', status: 'APPROVED', capturedAt: '2026-09-06T10:00:00.000Z', purgedAt: null, imagePurgedAt: null, legalHoldId: null },
  capture: { sha256: 'abc', sizeBytes: 100, mimeType: 'image/jpeg', encrypted: true, shreddedAt: null, deviceAndLocation: 'NOT_RECORDED' },
  extraction: [{ runId: 'r1', engine: 'spy', engineVersion: '1', outcome: 'OK', errorClass: null, ranExternally: false, fields: [{ code: 'doc_number', present: true, illegible: false }] }],
  validations: [{ code: 'V_ALL_REQUIRED_PRESENT', status: 'PASS', detailCode: null, blocking: true }],
  destruction: [{ at: '2026-09-07T01:00:00.000Z', by: 'image-policy', stores: ['storage:x'], bytesDeleted: 100, probe: 'CONFIRMED_ABSENT' }],
  audit: { entries: [], chain: { anchoredAt: '2026-09-07T02:00:00.000Z', anchoredHeadSeq: '10', anchorVerified: true } },
  timeline: [
    { at: '2026-09-06T09:59:00.000Z', actor: 'engine:spy@1', what: 'EXTRACTED OK' },
    { at: '2026-09-06T10:00:00.000Z', actor: 'acc1', what: 'SUBMITTED food_handler_cert as VENDOR_OWNER' },
    { at: '2026-09-06T11:00:00.000Z', actor: 'admin1', what: 'DECIDED APPROVE under LEGIBLE' },
    { at: '2026-09-07T01:00:00.000Z', actor: 'image-policy', what: 'DESTROYED from storage:x — probe CONFIRMED_ABSENT' },
  ],
  provable: ['A document of type food_handler_cert, hash abc, was submitted…'],
  notProvable: ['What the document looked like.'],
  generatedAt: '2026-09-07T03:00:00.000Z',
};

describe('custody view', () => {
  it('tones the timeline: decisions good, destruction as evidence, the rest neutral', () => {
    expect(timelineLines(n).map((l) => l.tone)).toEqual(['neutral', 'neutral', 'good', 'evidence']);
    expect(timelineLines(n)[1]!.actor).toBe('acc1');
  });
  it('the summary is one sentence a reviewer can read out', () => {
    const s = custodySummary(n);
    expect(s).toContain('food handler cert submitted');
    expect(s).toContain('1 extraction run, 1 verdict');
    expect(s).toContain('bytes destroyed (CONFIRMED_ABSENT)');
    expect(s).toContain('anchored and verified');
  });
  it('the proof lists are the server\'s, untouched', () => {
    expect(proofLists(n)).toEqual({ provable: n.provable, notProvable: n.notProvable });
  });
});
