import { describe, expect, it } from 'vitest';
import {
  assertDocumentReviewable,
  type ClaimedReviewAccess,
} from '../modules/verification/review-access';

function document(overrides: Partial<ClaimedReviewAccess['document']> = {}): ClaimedReviewAccess['document'] {
  return {
    id: 'document-review-state',
    tenantId: 'swift-default',
    userId: 'subject-review-state',
    fileUrl: '/uploads/verification/subject-review-state/evidence.enc',
    docType: 'national_id',
    status: 'PENDING',
    state: 'IN_REVIEW',
    storageProvenance: 'VERIFIED',
    storagePurgeRequestedAt: null,
    purgedAt: null,
    imagePurgedAt: null,
    ...overrides,
  };
}

function refusalCode(candidate: ClaimedReviewAccess['document']): string | null {
  try {
    assertDocumentReviewable(candidate);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

describe('locked verification-document reviewability', () => {
  it('accepts only a pending, in-review document with verified object ownership', () => {
    expect(() => assertDocumentReviewable(document())).not.toThrow();
  });

  it.each(['APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED', 'PURGED'])(
    'refuses terminal status %s even if an open assigned case survives',
    (status) => {
      expect(refusalCode(document({ status }))).toBe('DOCUMENT_NOT_REVIEWABLE');
    },
  );

  it.each(['REVIEW_QUEUED', 'APPROVED', 'REJECTED', 'COMMITTED', null])(
    'refuses non-review state %s',
    (state) => {
      expect(refusalCode(document({ state }))).toBe('DOCUMENT_NOT_REVIEWABLE');
    },
  );

  it.each([
    { purgedAt: new Date() },
    { imagePurgedAt: new Date() },
    { storagePurgeRequestedAt: new Date() },
  ])('refuses purge-complete and purge-pending evidence before disclosure', (override) => {
    expect(refusalCode(document(override))).toBe('DOCUMENT_PURGED');
  });

  it.each([
    { storageProvenance: 'UNVERIFIED' },
    { storageProvenance: 'QUARANTINED' },
    { fileUrl: '' },
  ])('refuses evidence without exact storage authority', (override) => {
    expect(refusalCode(document(override))).toBe('DOCUMENT_OWNERSHIP_INVALID');
  });
});
