import type { PrismaClient } from '@prisma/client';
import { IdentityService } from './identity.service';
import {
  normalizeDocNumber,
  normalizePlate,
  normalizePhone,
  normalizeEmail,
  normalizeDevice,
  normalizeIpSubnet,
  hashSignal,
} from './normalize';
import { log } from '../../utils/logger';

// The silent capture hooks (trial-integrity spec §2.1 / Part 12 phase 1).
// Every hook is FIRE-AND-FORGET by contract: identity capture must never
// break signup, verification, or billing — failures log loudly and the
// calling flow proceeds untouched. Raw values die here: normalize → hash →
// (raw discarded); only hashes travel further.

function service(prisma: PrismaClient): IdentityService {
  return new IdentityService(prisma);
}

/** Signup (§2.1 PHONE/EMAIL/DEVICE/IP_SUBNET + §5 SignupAttempt velocity row). */
/** [R048-007] The signup capture is AWAITED by its caller (bounded by `captureTimeoutMs`), so a
 *  failure is seen and counted where it happens instead of vanishing behind a `void`. Signup itself
 *  still succeeds when capture fails — a product rule (trial-integrity §2.1), now a stated one. */
export function captureSignup(
  prisma: PrismaClient,
  input: { userId: string; role: string; phone: string; email?: string | null; deviceId?: string | null; ip?: string | null },
): Promise<void> {
  return (async () => {
    const identity = service(prisma);
    await identity.capture({
      accountId: input.userId, actorRole: input.role,
      type: 'PHONE', normalizedValue: normalizePhone(input.phone), source: 'SIGNUP',
    });
    if (input.email) {
      await identity.capture({
        accountId: input.userId, actorRole: input.role,
        type: 'EMAIL', normalizedValue: normalizeEmail(input.email), source: 'SIGNUP',
      });
    }
    if (input.deviceId && input.deviceId !== 'unknown' && input.deviceId !== 'registration') {
      await identity.capture({
        accountId: input.userId, actorRole: input.role,
        type: 'DEVICE', normalizedValue: normalizeDevice(input.deviceId), source: 'DEVICE',
      });
    }
    if (input.ip) {
      await identity.capture({
        accountId: input.userId, actorRole: input.role,
        type: 'IP_SUBNET', normalizedValue: normalizeIpSubnet(input.ip), source: 'REQUEST_META',
      });
    }
    // §5 velocity ledger — recorded for every signup; thresholds live in
    // IntegritySettings (config, not code).
    const deviceHash = input.deviceId && input.deviceId !== 'unknown' ? hashSignal(normalizeDevice(input.deviceId)) : null;
    const attempt = await prisma.signupAttempt.create({
      data: {
        phoneHash: hashSignal(normalizePhone(input.phone)),
        deviceHash,
        ipHash: input.ip ? hashSignal(normalizeIpSubnet(input.ip)) : null,
        outcome: 'CREATED',
      },
    });

    // §5 device-velocity rule (rung 2 of the ladder): the Nth signup from one
    // device in 24h enters REVIEW_FIRST — signup itself completed normally
    // (the abuser learns nothing); ACTIVATION waits for a human because the
    // verification pipeline refuses to auto-approve held accounts.
    if (deviceHash) {
      const settings = await prisma.integritySettings.findUnique({ where: { id: 'platform' } });
      const maxPerDevice = settings?.maxSignupsPerDevice24h ?? 3;
      const dayAgo = new Date(Date.now() - 24 * 3600_000);
      const recent = await prisma.signupAttempt.count({ where: { deviceHash, createdAt: { gte: dayAgo } } });
      if (recent >= maxPerDevice) {
        await prisma.signupAttempt.update({ where: { id: attempt.id }, data: { outcome: 'REVIEW_FIRST' } });
        await prisma.enforcementAction.create({
          data: {
            accountId: input.userId,
            level: 'REVIEW_FIRST',
            reasonCode: 'VELOCITY_DEVICE',
            signalsFired: [{ type: 'DEVICE', windowHours: 24, signups: recent, threshold: maxPerDevice }] as never,
            decidedBy: 'SYSTEM',
          },
        });
        log().warn({ userId: input.userId, signups: recent }, 'device velocity breach — account enters REVIEW_FIRST');
      }
    }
  })(); // [R048-007] the caller awaits, bounds, counts and logs a failure — nothing is swallowed here
}

/** Extracted ID document number (§2.1 ID_DOC_NUMBER — HARD). The raw number
 *  arrives from the KYC result, is hashed here, and is never stored. */
export function captureDocumentNumber(
  prisma: PrismaClient,
  input: { userId: string; role: string; documentNumber: string },
): void {
  void service(prisma).capture({
    accountId: input.userId, actorRole: input.role,
    type: 'ID_DOC_NUMBER', normalizedValue: normalizeDocNumber(input.documentNumber), source: 'AI_ID_ANALYZER',
  }).catch((err) => log().error({ err, userId: input.userId }, 'doc-number identity capture failed — flow unaffected'));
}

/** Vehicle plate (§2.1 PLATE — HARD): one plate, one active vehicle-bound
 *  account. Captured when a driver's documents reach verified. */
export function capturePlate(
  prisma: PrismaClient,
  input: { userId: string; role: string; plate: string },
): void {
  void service(prisma).capture({
    accountId: input.userId, actorRole: input.role,
    type: 'PLATE', normalizedValue: normalizePlate(input.plate), source: 'ONBOARDING_DOC',
  }).catch((err) => log().error({ err, userId: input.userId }, 'plate identity capture failed — flow unaffected'));
}

/** MMG payer MSISDN (§2.1 MMG_PAYER — HARD: the money doesn't lie). Captured
 *  when a subscription's payer rail is declared and on successful charges;
 *  MMG is POLL-based in this stack, so "webhook time" reconciles to these
 *  two moments. */
export function captureMmgPayer(
  prisma: PrismaClient,
  input: { userId: string; role: string; payerMsisdn: string },
): void {
  void service(prisma).capture({
    accountId: input.userId, actorRole: input.role,
    type: 'MMG_PAYER', normalizedValue: normalizePhone(input.payerMsisdn), source: 'BILLING',
  }).catch((err) => log().error({ err, userId: input.userId }, 'mmg-payer identity capture failed — flow unaffected'));
}
