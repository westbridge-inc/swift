import type { CardObservationSource, CardObservationVerdict, CardObservedStatus, Prisma, PrismaClient } from '@prisma/client';
import { assertNever, type CardOutcomeStatus } from '../../providers/card/card-provider';

/**
 * [PT-1 · AH.10.9.2 step 6] One append-only row per card-rail answer: a
 * browser return, a session confirmation, an off-session charge, a
 * retrieval. The raw payload is never kept — its sha256 only — beside the
 * outcome parsed from it and what Swift decided. The database refuses UPDATE
 * and DELETE on the table, and derives the row's tenant from its session (or,
 * for an off-session charge, its instrument).
 */
export interface CardObservationInput {
  source: CardObservationSource;
  sessionId?: string | null;
  subscriptionId?: string | null;
  instrumentId?: string | null;
  paymentId?: string | null;
  provider: string;
  environment: string;
  rawSha256: string;
  parsedStatus: CardObservedStatus;
  verdict: CardObservationVerdict;
}

type ObservationWriter = Pick<PrismaClient, 'cardObservation'> | Pick<Prisma.TransactionClient, 'cardObservation'>;

export async function recordCardObservation(db: ObservationWriter, input: CardObservationInput): Promise<void> {
  await db.cardObservation.create({
    data: {
      source: input.source,
      sessionId: input.sessionId ?? null,
      subscriptionId: input.subscriptionId ?? null,
      instrumentId: input.instrumentId ?? null,
      paymentId: input.paymentId ?? null,
      provider: input.provider,
      environment: input.environment,
      rawSha256: input.rawSha256,
      parsedStatus: input.parsedStatus,
      verdict: input.verdict,
    },
  });
}

/** The closed set the observation column holds [C4 reads it exactly]. */
export function observedStatus(status: CardOutcomeStatus | 'invalid'): CardObservedStatus {
  switch (status) {
    case 'succeeded': return 'SUCCEEDED';
    case 'failed': return 'FAILED';
    case 'unknown': return 'UNKNOWN';
    case 'requires_action': return 'REQUIRES_ACTION';
    case 'pending': return 'PENDING';
    case 'invalid': return 'INVALID';
    default: return assertNever(status, 'card outcome status');
  }
}
