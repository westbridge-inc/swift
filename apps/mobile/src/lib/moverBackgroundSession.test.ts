import { describe, expect, it } from 'vitest';
import { decodeMoverLocationSession, encodeMoverLocationSession } from './moverBackgroundSession';

describe('durable mover background sessions', () => {
  it('round-trips a valid device-owned session', () => {
    const value = {
      kind: 'RIDER' as const,
      startedAt: 1_786_100_000_000,
      userId: 'account-a',
      generation: 3,
    };
    expect(decodeMoverLocationSession(encodeMoverLocationSession(value))).toEqual(value);
  });

  it('round-trips durable publication and cleanup state across task cold launches', () => {
    const value = {
      kind: 'DRIVER' as const,
      startedAt: 1_786_100_000_000,
      userId: 'account-a',
      generation: 3,
      lastPublishedAt: 1_786_100_008_000,
      lastLatitude: 6.81234,
      lastLongitude: -58.14321,
      cleanupPending: true as const,
      cleanupAttempts: 2,
      nextCleanupAttemptAt: 1_786_100_012_000,
    };
    expect(decodeMoverLocationSession(encodeMoverLocationSession(value))).toEqual(value);
  });

  it.each([
    null,
    '',
    'not-json',
    '{}',
    '{"kind":"DRIVER","startedAt":1}',
    '{"kind":"CUSTOMER","startedAt":1}',
    '{"kind":"DRIVER","startedAt":0}',
    '{"kind":"RIDER","startedAt":"today"}',
    '{"kind":"RIDER","startedAt":1,"userId":""}',
    '{"kind":"RIDER","startedAt":1,"userId":"a","lastPublishedAt":2}',
    '{"kind":"RIDER","startedAt":1,"userId":"a","lastPublishedAt":2,"lastLatitude":91,"lastLongitude":0}',
    '{"kind":"RIDER","startedAt":1,"userId":"a","cleanupPending":true}',
    // [MOB-017] a record without a login generation cannot be reauthorized — legacy records retire, never restore
    '{"kind":"RIDER","startedAt":1,"userId":"a"}',
    '{"kind":"RIDER","startedAt":1,"userId":"a","generation":-1}',
    '{"kind":"RIDER","startedAt":1,"userId":"a","generation":1.5}',
    '{"kind":"RIDER","startedAt":1,"userId":"a","generation":"1"}',
    '{"kind":"RIDER","startedAt":1,"userId":"a","generation":null}',
  ])('rejects corrupt or unauthorized durable state: %s', (raw) => {
    expect(decodeMoverLocationSession(raw)).toBeNull();
  });
});
