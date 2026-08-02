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

const TENANT = 'swift-default';

function service(prisma: PrismaClient): IdentityService {
  return new IdentityService(prisma);
}

/** Signup (§2.1 PHONE/EMAIL/DEVICE/IP_SUBNET + §5 SignupAttempt velocity row). */
export function captureSignup(
  prisma: PrismaClient,
  input: { userId: string; role: string; phone: string; email?: string | null; deviceId?: string | null; ip?: string | null },
): void {
  void (async () => {
    const identity = service(prisma);
    await identity.capture({
      accountId: input.userId, tenantId: TENANT, actorRole: input.role,
      type: 'PHONE', normalizedValue: normalizePhone(input.phone), source: 'SIGNUP',
    });
    if (input.email) {
      await identity.capture({
        accountId: input.userId, tenantId: TENANT, actorRole: input.role,
        type: 'EMAIL', normalizedValue: normalizeEmail(input.email), source: 'SIGNUP',
      });
    }
    if (input.deviceId && input.deviceId !== 'unknown' && input.deviceId !== 'registration') {
      await identity.capture({
        accountId: input.userId, tenantId: TENANT, actorRole: input.role,
        type: 'DEVICE', normalizedValue: normalizeDevice(input.deviceId), source: 'DEVICE',
      });
    }
    if (input.ip) {
      await identity.capture({
        accountId: input.userId, tenantId: TENANT, actorRole: input.role,
        type: 'IP_SUBNET', normalizedValue: normalizeIpSubnet(input.ip), source: 'REQUEST_META',
      });
    }
    // §5 velocity ledger — recorded for every signup; thresholds read it later.
    await prisma.signupAttempt.create({
      data: {
        phoneHash: hashSignal(normalizePhone(input.phone)),
        deviceHash: input.deviceId && input.deviceId !== 'unknown' ? hashSignal(normalizeDevice(input.deviceId)) : null,
        ipHash: input.ip ? hashSignal(normalizeIpSubnet(input.ip)) : null,
        outcome: 'CREATED',
      },
    });
  })().catch((err) => log().error({ err, userId: input.userId }, 'signup identity capture failed — flow unaffected'));
}

/** Extracted ID document number (§2.1 ID_DOC_NUMBER — HARD). The raw number
 *  arrives from the KYC result, is hashed here, and is never stored. */
export function captureDocumentNumber(
  prisma: PrismaClient,
  input: { userId: string; role: string; documentNumber: string },
): void {
  void service(prisma).capture({
    accountId: input.userId, tenantId: TENANT, actorRole: input.role,
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
    accountId: input.userId, tenantId: TENANT, actorRole: input.role,
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
    accountId: input.userId, tenantId: TENANT, actorRole: input.role,
    type: 'MMG_PAYER', normalizedValue: normalizePhone(input.payerMsisdn), source: 'BILLING',
  }).catch((err) => log().error({ err, userId: input.userId }, 'mmg-payer identity capture failed — flow unaffected'));
}
