import { describe, expect, it, vi } from 'vitest';
import { VerificationService } from '../modules/verification/verification.service';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = 'document-second-review';
const SUBJECT_ID = 'subject-second-review';
const REVIEWER_ID = 'reviewer-second-review';
const PEER_ID = 'peer-second-review';

function serviceWith(db: object) {
  return new VerificationService(db as never, {} as never, {} as never);
}

describe('second-review durable provenance', () => {
  it('accepts machine provenance only when the exact validator, consumed object, subject key and cross-account key agree', async () => {
    const sha256 = 'a'.repeat(64);
    const db = {
      validationResult: {
        findUnique: vi.fn().mockResolvedValue({
          submissionId: DOCUMENT_ID,
          validatorCode: 'V_SHA_COLLISION',
          status: 'WARN',
          detailCode: 'CROSS_SUBJECT_SHA',
        }),
      },
      verificationUpload: {
        findMany: vi.fn().mockResolvedValue([{ sha256 }]),
      },
      identityKey: {
        findMany: vi.fn().mockResolvedValue([
          { accountId: SUBJECT_ID },
          { accountId: PEER_ID },
        ]),
      },
    };
    const service = serviceWith(db);
    await expect((service as never as {
      assertSecondReviewProvenance: (...args: unknown[]) => Promise<void>;
    }).assertSecondReviewProvenance(db, {
      reviewCase: {
        id: CASE_ID,
        submissionId: DOCUMENT_ID,
        queue: 'SECOND_REVIEW',
        secondReviewOrigin: 'MACHINE_COLLISION',
        secondReviewEvidenceRef: '22222222-2222-4222-8222-222222222222',
      },
      subjectUserId: SUBJECT_ID,
      reviewerId: REVIEWER_ID,
    })).resolves.toBeUndefined();
    expect(db.identityKey.findMany).toHaveBeenCalledOnce();
  });

  it('fails closed when a collision validator exists but the cross-account blind signal does not', async () => {
    const db = {
      validationResult: {
        findUnique: vi.fn().mockResolvedValue({
          submissionId: DOCUMENT_ID,
          validatorCode: 'V_SHA_COLLISION',
          status: 'WARN',
          detailCode: 'CROSS_SUBJECT_SHA',
        }),
      },
      verificationUpload: {
        findMany: vi.fn().mockResolvedValue([{ sha256: 'b'.repeat(64) }]),
      },
      identityKey: {
        findMany: vi.fn().mockResolvedValue([{ accountId: SUBJECT_ID }]),
      },
    };
    const service = serviceWith(db);
    await expect((service as never as {
      assertSecondReviewProvenance: (...args: unknown[]) => Promise<void>;
    }).assertSecondReviewProvenance(db, {
      reviewCase: {
        id: CASE_ID,
        submissionId: DOCUMENT_ID,
        queue: 'SECOND_REVIEW',
        secondReviewOrigin: 'MACHINE_COLLISION',
        secondReviewEvidenceRef: '22222222-2222-4222-8222-222222222222',
      },
      subjectUserId: SUBJECT_ID,
      reviewerId: REVIEWER_ID,
    })).rejects.toMatchObject({ code: 'SECOND_REVIEW_PROVENANCE_INVALID' });
  });

  it('binds human provenance to the exact ESCALATE decision and excludes its author', async () => {
    const db = {
      reviewDecision: {
        findUnique: vi.fn().mockResolvedValue({
          caseId: CASE_ID,
          reviewerId: REVIEWER_ID,
          outcome: 'ESCALATE',
        }),
      },
    };
    const service = serviceWith(db);
    const verify = (reviewerId: string) => (service as never as {
      assertSecondReviewProvenance: (...args: unknown[]) => Promise<void>;
    }).assertSecondReviewProvenance(db, {
      reviewCase: {
        id: CASE_ID,
        submissionId: DOCUMENT_ID,
        queue: 'SECOND_REVIEW',
        secondReviewOrigin: 'HUMAN_ESCALATION',
        secondReviewEvidenceRef: '33333333-3333-4333-8333-333333333333',
      },
      subjectUserId: SUBJECT_ID,
      reviewerId,
    });
    await expect(verify(REVIEWER_ID)).rejects.toMatchObject({ code: 'SECOND_REVIEWER_REQUIRED' });
    await expect(verify('independent-reviewer')).resolves.toBeUndefined();
  });

  it('fails closed if a case is downgraded from SECOND_REVIEW while retaining provenance', async () => {
    const service = serviceWith({});
    await expect((service as never as {
      assertSecondReviewProvenance: (...args: unknown[]) => Promise<void>;
    }).assertSecondReviewProvenance({}, {
      reviewCase: {
        id: CASE_ID,
        submissionId: DOCUMENT_ID,
        queue: 'STANDARD',
        secondReviewOrigin: 'HUMAN_ESCALATION',
        secondReviewEvidenceRef: '33333333-3333-4333-8333-333333333333',
      },
      subjectUserId: SUBJECT_ID,
      reviewerId: REVIEWER_ID,
    })).rejects.toMatchObject({ code: 'SECOND_REVIEW_PROVENANCE_INVALID' });
  });
});

describe('review assignment epochs', () => {
  it('rotates the epoch after release and revokes only the relinquished assignment grants before clearing ownership', async () => {
    const reviewCase = {
      id: CASE_ID,
      tenantId: 'swift-default',
      submissionId: DOCUMENT_ID,
      queue: 'STANDARD',
      assignedTo: null as string | null,
      assignedAt: null as Date | null,
      assignmentEpoch: null as string | null,
      secondReviewOrigin: null,
      secondReviewEvidenceRef: null,
      closedAt: null,
      createdAt: new Date('2026-09-09T00:00:00.000Z'),
    };
    const grantRevocations: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    let rawIndex = 0;
    const tx = {
      $queryRaw: vi.fn(async () => {
        const phase = rawIndex++ % 4;
        if (phase === 0) return [{ locked: '1' }];
        if (phase === 1) return [{ id: SUBJECT_ID }, { id: REVIEWER_ID }];
        if (phase === 2) return [{ id: DOCUMENT_ID, userId: SUBJECT_ID, tenantId: 'swift-default' }];
        return [{ ...reviewCase }];
      }),
      identityClusterMember: { findUnique: vi.fn().mockResolvedValue(null) },
      reviewRenderGrant: {
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          grantRevocations.push({ where, data });
          return { count: 1 };
        }),
      },
      reviewCase: {
        updateMany: vi.fn(async ({ data }: { data: Partial<typeof reviewCase> }) => {
          Object.assign(reviewCase, data);
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => ({ ...reviewCase })),
      },
      verificationDocument: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const db = {
      reviewCase: { findUnique: vi.fn(async () => ({ ...reviewCase })) },
      verificationDocument: {
        findUnique: vi.fn().mockResolvedValue({ userId: SUBJECT_ID, tenantId: 'swift-default' }),
      },
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const service = serviceWith(db);

    const first = await service.claimReviewCase(CASE_ID, REVIEWER_ID) as { assignmentEpoch: string };
    expect(first.assignmentEpoch).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const firstEpoch = first.assignmentEpoch;

    await service.releaseReviewCase(CASE_ID, REVIEWER_ID);
    expect(reviewCase.assignmentEpoch).toBeNull();
    expect(grantRevocations).toContainEqual(expect.objectContaining({
      where: { caseId: CASE_ID, assignmentEpoch: firstEpoch, consumedAt: null, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    }));

    const second = await service.claimReviewCase(CASE_ID, REVIEWER_ID) as { assignmentEpoch: string };
    expect(second.assignmentEpoch).not.toBe(firstEpoch);
  });
});
