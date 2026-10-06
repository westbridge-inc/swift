import { describe, expect, it } from 'vitest';
import {
  parseServiceJobLifecycleCommand,
  quoteSchema,
  scheduleSchema,
  scheduledTransitionSchema,
  transitionGenerationSchema,
} from './service-job-client-contract';
import {
  SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER,
  SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
} from '@swift/types';

const previousMobileBodies = [
  {
    command: 'schedule',
    schema: scheduleSchema,
    body: { scheduledFor: '2026-09-21T13:00:00.000Z' },
  },
  { command: 'cancel', schema: transitionGenerationSchema, body: {} },
  { command: 'quote', schema: quoteSchema, body: { amount: 8_000 } },
  { command: 'confirm', schema: scheduledTransitionSchema, body: {} },
  { command: 'decline-slot', schema: scheduledTransitionSchema, body: {} },
  { command: 'complete', schema: transitionGenerationSchema, body: {} },
] as const;

describe('service-job lifecycle client contract', () => {
  it.each(previousMobileBodies)(
    'turns the previous mobile $command body into a deliberate upgrade response before validation',
    ({ schema, body }) => {
      expect(() => parseServiceJobLifecycleCommand({ headers: {}, body }, schema))
        .toThrow(expect.objectContaining({
          statusCode: 426,
          code: 'CLIENT_UPGRADE_REQUIRED',
          details: {
            upgradeRequired: true,
            contractHeader: SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER,
            requiredContract: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
          },
        }));
    },
  );

  it('does not infer a missing generation after the client opts into the current contract', () => {
    expect(() => parseServiceJobLifecycleCommand({
      headers: {
        [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
      },
      body: { amount: 8_000 },
    }, quoteSchema)).toThrow(expect.objectContaining({ name: 'ZodError' }));
  });

  it('accepts the current contract only when every command fact is explicit', () => {
    const headers = {
      [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
    };
    const expectedUpdatedAt = '2026-09-20T12:00:00.000Z';
    const expectedScheduledFor = '2026-09-21T13:00:00.000Z';

    expect(parseServiceJobLifecycleCommand({
      headers,
      body: { amount: 8_000, expectedUpdatedAt },
    }, quoteSchema)).toMatchObject({ amount: 8_000, expectedUpdatedAt: new Date(expectedUpdatedAt) });
    expect(parseServiceJobLifecycleCommand({
      headers,
      body: {
        scheduledFor: expectedScheduledFor,
        expectedUpdatedAt,
        expectedQuoteAmount: 8_000,
      },
    }, scheduleSchema)).toMatchObject({
      scheduledFor: new Date(expectedScheduledFor),
      expectedUpdatedAt: new Date(expectedUpdatedAt),
      expectedQuoteAmount: 8_000,
    });
    expect(parseServiceJobLifecycleCommand({
      headers,
      body: { expectedScheduledFor, expectedUpdatedAt },
    }, scheduledTransitionSchema)).toMatchObject({
      expectedScheduledFor: new Date(expectedScheduledFor),
      expectedUpdatedAt: new Date(expectedUpdatedAt),
    });
  });

  it('rejects an unknown contract instead of assuming forward compatibility', () => {
    expect(() => parseServiceJobLifecycleCommand({
      headers: { [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: '3' },
      body: { expectedUpdatedAt: '2026-09-20T12:00:00.000Z' },
    }, transitionGenerationSchema)).toThrow(expect.objectContaining({
      statusCode: 426,
      code: 'CLIENT_UPGRADE_REQUIRED',
    }));
  });
});
