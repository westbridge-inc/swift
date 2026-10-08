import {
  SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER,
  SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
} from '@swift/types';
import { z } from 'zod';
import { AppError } from '../../utils/errors';
import { serviceQuoteAmountSchema } from './service-job-transition';

export const transitionGenerationSchema = z.object({ expectedUpdatedAt: z.coerce.date() });
export const quoteSchema = transitionGenerationSchema.extend({ amount: serviceQuoteAmountSchema });
export const scheduleSchema = transitionGenerationSchema.extend({
  scheduledFor: z.coerce.date(),
  expectedQuoteAmount: serviceQuoteAmountSchema,
});
export const scheduledTransitionSchema = transitionGenerationSchema.extend({
  expectedScheduledFor: z.coerce.date(),
});

// [build-9 compatibility] The app already in the stores sends the old bodies
// with no contract header and no command generation. Those requests are still
// served, with every server-side safety rule applied; the generation they did
// not send is taken from the row read in the same request, so the write is
// still a compare-and-set and a concurrent change still loses cleanly.
export const legacyQuoteSchema = z.object({ amount: serviceQuoteAmountSchema });
export const legacyScheduleSchema = z.object({ scheduledFor: z.coerce.date() });
export const legacyTransitionSchema = z.object({}).passthrough();

interface ServiceJobLifecycleRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export type ServiceJobCommand<Current, Legacy> =
  | { legacy: false; body: Current }
  | { legacy: true; body: Legacy };

/**
 * The current client names its contract and sends every command fact. A
 * request with no contract header is the store build already installed: it is
 * served under the same server-side rules (see above). A request naming a
 * DIFFERENT contract is refused deliberately: a future incompatible client
 * must negotiate its own rollout rather than being assumed compatible.
 */
export function readServiceJobLifecycleCommand<Schema extends z.ZodTypeAny, LegacySchema extends z.ZodTypeAny>(
  request: ServiceJobLifecycleRequest,
  schema: Schema,
  legacySchema: LegacySchema,
): ServiceJobCommand<z.infer<Schema>, z.infer<LegacySchema>> {
  const contract = request.headers[SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER];
  if (contract === undefined) return { legacy: true, body: legacySchema.parse(request.body ?? {}) };
  if (contract !== SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION) {
    throw new AppError(
      426,
      'CLIENT_UPGRADE_REQUIRED',
      'Update Swift to continue managing this service job.',
      {
        upgradeRequired: true,
        contractHeader: SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER,
        requiredContract: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
      },
    );
  }
  return { legacy: false, body: schema.parse(request.body) };
}

/** The facts a lifecycle write is conditioned on: from the command, or (legacy) from the row read now. */
export function commandGeneration(
  command: ServiceJobCommand<{ expectedUpdatedAt?: Date; expectedScheduledFor?: Date; expectedQuoteAmount?: number }, unknown>,
  job: { updatedAt: Date; scheduledFor: Date | null; quoteAmount: unknown },
): { expectedUpdatedAt: Date; expectedScheduledFor: Date | null; expectedQuoteAmount: number | null } {
  const sent = command.legacy ? {} : command.body;
  return {
    expectedUpdatedAt: sent.expectedUpdatedAt ?? job.updatedAt,
    expectedScheduledFor: sent.expectedScheduledFor ?? job.scheduledFor,
    expectedQuoteAmount: sent.expectedQuoteAmount ?? (job.quoteAmount == null ? null : Number(job.quoteAmount)),
  };
}
