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

interface ServiceJobLifecycleRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/**
 * The previous mobile release omitted the command generation and accepted
 * quote/slot facts. Refuse it deliberately before body validation instead of
 * returning a generic Zod error or, worse, inferring current authority from
 * the row. Only the exact contract is accepted: a future incompatible client
 * must negotiate its own rollout rather than being assumed compatible.
 */
export function parseServiceJobLifecycleCommand<Schema extends z.ZodTypeAny>(
  request: ServiceJobLifecycleRequest,
  schema: Schema,
): z.infer<Schema> {
  const contract = request.headers[SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER];
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
  return schema.parse(request.body);
}
