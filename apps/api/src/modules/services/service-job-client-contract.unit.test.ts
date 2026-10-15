import { describe, expect, it } from 'vitest';
import {
  commandGeneration,
  legacyQuoteSchema,
  legacyScheduleSchema,
  legacyTransitionSchema,
  quoteSchema,
  readServiceJobLifecycleCommand,
  scheduleSchema,
  scheduledTransitionSchema,
  transitionGenerationSchema,
} from './service-job-client-contract';
import {
  SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER,
  SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
} from '@swift/types';

// The bodies the app already in the stores (build 9) sends: no contract header,
// no command generation.
const previousMobileBodies = [
  { command: 'schedule', schema: scheduleSchema, legacy: legacyScheduleSchema, body: { scheduledFor: '2026-09-21T13:00:00.000Z' } },
  { command: 'cancel', schema: transitionGenerationSchema, legacy: legacyTransitionSchema, body: {} },
  { command: 'quote', schema: quoteSchema, legacy: legacyQuoteSchema, body: { amount: 8_000 } },
  { command: 'confirm', schema: scheduledTransitionSchema, legacy: legacyTransitionSchema, body: {} },
  { command: 'decline-slot', schema: scheduledTransitionSchema, legacy: legacyTransitionSchema, body: {} },
  { command: 'complete', schema: transitionGenerationSchema, legacy: legacyTransitionSchema, body: {} },
] as const;

const current = { [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION };

describe('service-job lifecycle client contract', () => {
  it.each(previousMobileBodies)(
    'serves the installed app\'s $command body as a legacy command (no upgrade wall)',
    ({ schema, legacy, body }) => {
      const command = readServiceJobLifecycleCommand({ headers: {}, body }, schema, legacy);
      expect(command.legacy).toBe(true);
    },
  );

  it('a legacy command takes its generation from the row read in the same request', () => {
    const row = { updatedAt: new Date('2026-09-20T12:00:00.000Z'), scheduledFor: new Date('2026-09-21T13:00:00.000Z'), quoteAmount: '8000.00' };
    const command = readServiceJobLifecycleCommand({ headers: {}, body: {} }, scheduledTransitionSchema, legacyTransitionSchema);
    expect(commandGeneration(command, row)).toEqual({
      expectedUpdatedAt: row.updatedAt, expectedScheduledFor: row.scheduledFor, expectedQuoteAmount: 8000,
    });
  });

  it('a current command keeps the facts the client saw, even when the row has moved on', () => {
    const row = { updatedAt: new Date('2026-09-20T12:05:00.000Z'), scheduledFor: new Date('2026-09-22T13:00:00.000Z'), quoteAmount: '9000.00' };
    const command = readServiceJobLifecycleCommand({
      headers: current,
      body: { expectedUpdatedAt: '2026-09-20T12:00:00.000Z', expectedScheduledFor: '2026-09-21T13:00:00.000Z' },
    }, scheduledTransitionSchema, legacyTransitionSchema);
    expect(command.legacy).toBe(false);
    expect(commandGeneration(command, row)).toMatchObject({
      expectedUpdatedAt: new Date('2026-09-20T12:00:00.000Z'), expectedScheduledFor: new Date('2026-09-21T13:00:00.000Z'),
    });
  });

  it('does not infer a missing generation after the client opts into the current contract', () => {
    expect(() => readServiceJobLifecycleCommand({ headers: current, body: { amount: 8_000 } }, quoteSchema, legacyQuoteSchema))
      .toThrow(expect.objectContaining({ name: 'ZodError' }));
  });

  it('accepts the current contract only when every command fact is explicit', () => {
    const expectedUpdatedAt = '2026-09-20T12:00:00.000Z';
    const expectedScheduledFor = '2026-09-21T13:00:00.000Z';
    expect(readServiceJobLifecycleCommand({ headers: current, body: { amount: 8_000, expectedUpdatedAt } }, quoteSchema, legacyQuoteSchema).body)
      .toMatchObject({ amount: 8_000, expectedUpdatedAt: new Date(expectedUpdatedAt) });
    expect(readServiceJobLifecycleCommand({
      headers: current,
      body: { scheduledFor: expectedScheduledFor, expectedUpdatedAt, expectedQuoteAmount: 8_000 },
    }, scheduleSchema, legacyScheduleSchema).body).toMatchObject({
      scheduledFor: new Date(expectedScheduledFor), expectedUpdatedAt: new Date(expectedUpdatedAt), expectedQuoteAmount: 8_000,
    });
    expect(readServiceJobLifecycleCommand({ headers: current, body: { expectedScheduledFor, expectedUpdatedAt } }, scheduledTransitionSchema, legacyTransitionSchema).body)
      .toMatchObject({ expectedScheduledFor: new Date(expectedScheduledFor), expectedUpdatedAt: new Date(expectedUpdatedAt) });
  });

  it('rejects an unknown contract instead of assuming forward compatibility', () => {
    expect(() => readServiceJobLifecycleCommand({
      headers: { [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: '3' },
      body: { expectedUpdatedAt: '2026-09-20T12:00:00.000Z' },
    }, transitionGenerationSchema, legacyTransitionSchema)).toThrow(expect.objectContaining({
      statusCode: 426,
      code: 'CLIENT_UPGRADE_REQUIRED',
    }));
  });
});
