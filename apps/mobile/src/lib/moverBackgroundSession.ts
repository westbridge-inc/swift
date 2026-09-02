import type { MoverKind } from './moverLocation';

/**
 * The durable authority record for background mover tracking.
 *
 * [MOB-017] It is bound to the LOGIN GENERATION, not only the user: a same-user
 * logout/login is a new principal boundary, and a record written under the old
 * one must never restore native tracking under the new one. A legacy record
 * without a generation cannot be reauthorized and does not decode — the fresh
 * runtime treats it as unknown authority (native stopped), and the person goes
 * online again explicitly.
 */
export interface DurableMoverLocationSession {
  kind: MoverKind;
  startedAt: number;
  /** Principal identity only; credentials remain in encrypted auth storage. */
  userId: string;
  /** The login generation that authorized this tracking session. */
  generation: number;
  /** Last accepted publication is durable because TaskManager may cold-launch
   * a fresh JS runtime for each native event. All three fields are atomic. */
  lastPublishedAt?: number;
  lastLatitude?: number;
  lastLongitude?: number;
  /** Two-phase native teardown tombstone. A fresh runtime never restores or
   * publishes this session; it retries cleanup after the durable backoff. */
  cleanupPending?: true;
  cleanupAttempts?: number;
  nextCleanupAttemptAt?: number;
}

export function encodeMoverLocationSession(session: DurableMoverLocationSession): string {
  return JSON.stringify(session);
}

export function decodeMoverLocationSession(raw: string | null): DurableMoverLocationSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DurableMoverLocationSession>;
    if (value.kind !== 'DRIVER' && value.kind !== 'RIDER') return null;
    if (!Number.isFinite(value.startedAt) || (value.startedAt as number) <= 0) return null;
    if (typeof value.userId !== 'string' || !value.userId.trim() || value.userId.length > 128) return null;
    if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return null;
    const hasPublicationState = value.lastPublishedAt !== undefined
      || value.lastLatitude !== undefined
      || value.lastLongitude !== undefined;
    if (hasPublicationState && (
      !Number.isFinite(value.lastPublishedAt)
      || (value.lastPublishedAt as number) < (value.startedAt as number)
      || !Number.isFinite(value.lastLatitude)
      || (value.lastLatitude as number) < -90
      || (value.lastLatitude as number) > 90
      || !Number.isFinite(value.lastLongitude)
      || (value.lastLongitude as number) < -180
      || (value.lastLongitude as number) > 180
    )) return null;

    const hasCleanupState = value.cleanupPending !== undefined
      || value.cleanupAttempts !== undefined
      || value.nextCleanupAttemptAt !== undefined;
    if (hasCleanupState && (
      value.cleanupPending !== true
      || !Number.isInteger(value.cleanupAttempts)
      || (value.cleanupAttempts as number) < 1
      || (value.cleanupAttempts as number) > 1_000_000
      || !Number.isFinite(value.nextCleanupAttemptAt)
      || (value.nextCleanupAttemptAt as number) <= 0
    )) return null;

    return {
      kind: value.kind,
      startedAt: value.startedAt as number,
      userId: value.userId,
      generation: value.generation as number,
      ...(hasPublicationState ? {
        lastPublishedAt: value.lastPublishedAt as number,
        lastLatitude: value.lastLatitude as number,
        lastLongitude: value.lastLongitude as number,
      } : {}),
      ...(hasCleanupState ? {
        cleanupPending: true as const,
        cleanupAttempts: value.cleanupAttempts as number,
        nextCleanupAttemptAt: value.nextCleanupAttemptAt as number,
      } : {}),
    };
  } catch {
    return null;
  }
}
