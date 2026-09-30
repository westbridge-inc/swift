import type { DocState } from '@prisma/client';

export type SweepFailureStage = 'provider_reconcile' | 'document_expiry' | 'expiry_effects' | 'expiry_policy_hold';
export interface SweepFailureSample { stage: SweepFailureStage; id: string; state?: DocState | null }
export const SWEEP_FAILURE_SAMPLE_LIMIT = 10;

/** Exact counts, bounded row samples, and no free-form exception/processor data.
 * Throw only after unrelated work has run; the job must still fail for retry. */
export class VerificationSweepIncomplete extends Error {
  readonly code = 'VERIFICATION_SWEEP_INCOMPLETE';
  constructor(
    readonly completed: number,
    readonly counts: Partial<Record<SweepFailureStage, number>>,
    readonly samples: readonly SweepFailureSample[],
  ) {
    super(`Verification sweep incomplete: ${Object.values(counts).reduce((sum, n) => sum + n, 0)} failed or held rows; ${completed} completed`);
    this.name = 'VerificationSweepIncomplete';
  }
}

export class SweepFailures {
  private readonly counts: Partial<Record<SweepFailureStage, number>> = {};
  private readonly samples: SweepFailureSample[] = [];

  add(stage: SweepFailureStage, id: string, state?: DocState | null): void {
    this.counts[stage] = (this.counts[stage] ?? 0) + 1;
    if (this.samples.length < SWEEP_FAILURE_SAMPLE_LIMIT) this.samples.push({ stage, id, ...(state !== undefined && { state }) });
  }

  merge(error: VerificationSweepIncomplete): void {
    for (const [stage, count] of Object.entries(error.counts)) {
      const key = stage as SweepFailureStage;
      this.counts[key] = (this.counts[key] ?? 0) + count;
    }
    this.samples.push(...error.samples.slice(0, SWEEP_FAILURE_SAMPLE_LIMIT - this.samples.length));
  }

  throwIfAny(completed: number): void {
    if (Object.keys(this.counts).length) throw new VerificationSweepIncomplete(completed, { ...this.counts }, [...this.samples]);
  }
}
