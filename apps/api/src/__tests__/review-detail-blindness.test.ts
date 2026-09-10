import { describe, expect, it } from 'vitest';
import type { ReviewOutcome, ReviewQueue } from '@prisma/client';
import {
  renderDocumentReviewDetail,
  reviewCasesForActiveLane,
  type ReviewDetailSnapshot,
} from '../modules/verification/review-detail';

const at = new Date('2026-09-09T12:00:00.000Z');

function reviewCase(
  id: string,
  queue: ReviewQueue,
  decisions: Array<{ outcome: ReviewOutcome; reasonCode: string }> = [],
) {
  return {
    id,
    queue,
    priority: 50,
    slaDueAt: at,
    assignedAt: at,
    closedAt: null,
    createdAt: at,
    decisions: decisions.map((decision) => ({
      ...decision,
      actorFacingCategory: 'CATEGORY',
      decidedAt: at,
      timeOnCaseMs: 1_000,
    })),
  };
}

function snapshot(
  cases: ReturnType<typeof reviewCase>[],
  validationResults: Array<{
    validatorCode: string;
    status: 'PASS' | 'WARN' | 'FAIL' | 'NOT_RUN';
    detailCode: string | null;
  }> = [],
): ReviewDetailSnapshot {
  return {
    document: {
      id: 'document-blind',
      userId: 'subject-blind',
      role: 'DRIVER',
      docType: 'national_id',
      status: 'PENDING',
      state: 'IN_REVIEW',
      expiresAt: null,
      consentAt: at,
      privacyNoticeVersion: 'v1',
      retentionExpiresAt: at,
      purgedAt: null,
      imagePurgedAt: null,
      legalHoldId: null,
      storageProvenance: 'VERIFIED',
      storageAnomalyCode: null,
      createdAt: at,
      reviewedAt: null,
      user: {
        id: 'subject-blind',
        firstName: 'Evidence',
        lastName: 'Only',
        phone: '+5920000000',
        countryCode: 'GY',
        driver: null,
      },
      legalHold: null,
      extractionRuns: [],
      validationResults: validationResults.map((validation) => ({
        ...validation,
        isBlocking: false,
        evaluatedAt: at,
      })),
    },
    upload: null,
    cases,
    registry: null,
  } as ReviewDetailSnapshot;
}

describe('review detail blind-lane serialization', () => {
  it('serializes machine-collision and human-escalation second reviews identically apart from opaque case identity', () => {
    const machine = reviewCasesForActiveLane(
      [reviewCase('machine-current', 'SECOND_REVIEW')],
      { currentCaseId: 'machine-current', currentQueue: 'SECOND_REVIEW' },
    );
    const human = reviewCasesForActiveLane(
      [
        reviewCase('human-prior', 'STANDARD', [{ outcome: 'ESCALATE', reasonCode: 'HUMAN_REASON' }]),
        reviewCase('human-current', 'SECOND_REVIEW'),
      ],
      { currentCaseId: 'human-current', currentQueue: 'SECOND_REVIEW' },
    );

    const machineJson = JSON.stringify(machine);
    const humanJson = JSON.stringify(human);
    for (const serialized of [machineJson, humanJson]) {
      expect(serialized).not.toContain('priorDecisionCount');
      expect(serialized).not.toContain('outcome');
      expect(serialized).not.toContain('reasonCode');
      expect(serialized).not.toContain('ESCALATE');
      expect(serialized).toContain('"independentReviewRequired":true');
    }
    expect(machine).toHaveLength(1);
    expect(human).toHaveLength(1);
    expect({ ...machine[0], id: 'opaque' }).toEqual({ ...human[0], id: 'opaque' });
  });

  it('removes a prior STANDARD decision from a current QA_BLIND response', () => {
    const shaped = reviewCasesForActiveLane(
      [
        reviewCase('prior-standard', 'STANDARD', [{ outcome: 'APPROVE', reasonCode: 'MATCH' }]),
        reviewCase('current-blind', 'QA_BLIND'),
      ],
      { currentCaseId: 'current-blind', currentQueue: 'QA_BLIND' },
    );

    expect(shaped).toHaveLength(1);
    expect(shaped[0]).toMatchObject({
      id: 'current-blind',
      queue: 'QA_BLIND',
      independentReviewRequired: true,
      decisions: [],
    });
    expect(JSON.stringify(shaped)).not.toMatch(/prior-standard|APPROVE|MATCH|priorDecisionCount/);
  });

  it('returns decision history when the actively locked lane is not independent', () => {
    const shaped = reviewCasesForActiveLane(
      [reviewCase('current-standard', 'STANDARD', [{ outcome: 'APPROVE', reasonCode: 'MATCH' }])],
      { currentCaseId: 'current-standard', currentQueue: 'STANDARD' },
    );

    expect(shaped[0]).toMatchObject({
      independentReviewRequired: false,
      priorDecisionCount: 1,
      decisions: [{ outcome: 'APPROVE', reasonCode: 'MATCH' }],
    });
  });

  it('makes full machine-collision and human-escalation responses origin-blind', async () => {
    const machineCase = reviewCase('machine-current', 'SECOND_REVIEW');
    const humanCase = reviewCase('human-current', 'SECOND_REVIEW');
    const machine = await renderDocumentReviewDetail(
      snapshot([machineCase], [{
        validatorCode: 'V_SHA_COLLISION',
        status: 'WARN',
        detailCode: 'CROSS_SUBJECT_SHA',
      }]),
      { currentCaseId: machineCase.id, currentQueue: 'SECOND_REVIEW' },
    );
    const human = await renderDocumentReviewDetail(
      snapshot([
        reviewCase('human-prior', 'STANDARD', [{ outcome: 'ESCALATE', reasonCode: 'HUMAN_REASON' }]),
        humanCase,
      ]),
      { currentCaseId: humanCase.id, currentQueue: 'SECOND_REVIEW' },
    );

    expect(machine.validations).toEqual([]);
    expect(human.validations).toEqual([]);
    const normalized = (value: typeof machine) => ({
      ...value,
      cases: value.cases.map((entry) => ({ ...entry, id: 'opaque-case' })),
    });
    expect(normalized(machine)).toEqual(normalized(human));
    expect(JSON.stringify(machine)).not.toMatch(/V_SHA_COLLISION|CROSS_SUBJECT_SHA/);
  });
});
