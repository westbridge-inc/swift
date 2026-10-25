import { lockIdentityAuthority } from './identity-review';
import { recordMmgPayerObservation } from './mmg-payer-evidence';
import type { PrismaClient } from '@prisma/client';
import { IdentityService } from './identity.service';
import {
  normalizePhone,
  normalizeEmail,
  normalizeDevice,
  normalizeIpSubnet,
  isPublicNetworkAddress,
  hashSignal,
} from './normalize';
import { log } from '../../utils/logger';
import { runtimeMode } from '../../utils/runtime-mode';

// The silent capture hooks (trial-integrity spec §2.1 / Part 12 phase 1).
// Every hook is FIRE-AND-FORGET by contract: identity capture must never
// break signup, verification, or billing — failures log loudly and the
// calling flow proceeds untouched. Raw values die here: normalize → hash →
// (raw discarded); only hashes travel further.

function service(prisma: PrismaClient): IdentityService {
  return new IdentityService(prisma);
}

/** [AUD-1 row 301] Device values that name no device: no header, a blank one, the route's own
 *  'unknown' default, or the 'registration' session placeholder. None of them is ever a pass. */
const NO_DEVICE: ReadonlySet<string> = new Set(['', 'unknown', 'registration']);

/** [AUD-1 row 301] The bucket a signup that names no device is filed under: the unknown devices of
 *  its network (or, with no network at all, the unattributed ones). Every device on that network
 *  shares it, so it is judged with the NETWORK threshold (below), never the per-device one. */
export function unknownDeviceBucket(network: string | null): string {
  return `unknown-device@${network ?? 'unattributed'}`;
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
    const device = normalizeDevice(input.deviceId ?? '');
    const deviceNamed = !NO_DEVICE.has(device);
    if (deviceNamed) {
      await identity.capture({
        accountId: input.userId, actorRole: input.role,
        type: 'DEVICE', normalizedValue: device, source: 'DEVICE',
      });
    }
    // input.ip is request.ip: it follows TRUST_PROXY (config/trust-proxy.ts), so a raw
    // X-Forwarded-For never chooses the network a signup is counted against.
    const network = input.ip ? normalizeIpSubnet(input.ip) : null;
    if (network) {
      await identity.capture({
        accountId: input.userId, actorRole: input.role,
        type: 'IP_SUBNET', normalizedValue: network, source: 'REQUEST_META',
      });
    }
    // §5 velocity ledger — recorded for every signup; thresholds live in
    // IntegritySettings (config, not code). [AUD-1 row 301] A signup that names
    // no device is filed under the unknown-device bucket of its network, never
    // under "no device" (which no rung could ever count).
    const deviceHash = hashSignal(deviceNamed ? device : unknownDeviceBucket(network));
    const ipHash = network ? hashSignal(network) : null;
    const attempt = await prisma.signupAttempt.create({
      data: {
        phoneHash: hashSignal(normalizePhone(input.phone)),
        deviceHash,
        ipHash,
        outcome: 'CREATED',
      },
    });

    // The ladder's signup rungs (rung 2, REVIEW_FIRST): the Nth signup in 24h
    // from one device, or from one network, enters REVIEW_FIRST. Signup itself
    // completed normally (the abuser learns nothing); ACTIVATION waits for a
    // human because the verification pipeline refuses to auto-approve held
    // accounts. Nothing here refuses a signup or tells the person anything.
    const settings = await prisma.integritySettings.findUnique({ where: { id: 'platform' } });
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const fired: Array<Record<string, unknown>> = [];

    // Device rung: a NAMED device, at maxSignupsPerDevice24h (default 3).
    if (deviceNamed) {
      const maxPerDevice = settings?.maxSignupsPerDevice24h ?? 3;
      const recent = await prisma.signupAttempt.count({ where: { deviceHash, createdAt: { gte: dayAgo } } });
      if (recent >= maxPerDevice) fired.push({ type: 'DEVICE', windowHours: 24, signups: recent, threshold: maxPerDevice });
    }

    // [AUD-1 row 301] Network rung: EVERY signup from a public network (IPv4
    // /24, IPv6 /64), whatever device it names — and the only rung for one
    // that names none, since that one's device bucket is its network. The
    // threshold is ipFlagThreshold24h, default 15 signups in 24 h: deliberately
    // high, because carrier NAT puts many real Guyana users behind one network,
    // and crossing it never refuses anyone — a person checks the account at
    // activation. Only a public address names an outside network: a
    // loopback/private one is our own side of a proxy, and counting it would
    // file every user behind that hop under one bucket.
    if (ipHash && input.ip && isPublicNetworkAddress(input.ip)) {
      const networkThreshold = settings?.ipFlagThreshold24h ?? 15;
      const fromNetwork = await prisma.signupAttempt.count({ where: { ipHash, createdAt: { gte: dayAgo } } });
      if (fromNetwork >= networkThreshold) {
        fired.push({ type: 'IP_SUBNET', windowHours: 24, signups: fromNetwork, threshold: networkThreshold, deviceHeader: deviceNamed ? 'sent' : 'missing' });
      }
    } else if (input.ip && runtimeMode() !== 'test' && runtimeMode() !== 'development') {
      // A deployed API sees public client addresses (TRUST_PROXY covers its proxy). Say so when it does not.
      log().warn({ userId: input.userId }, '[AUD-1 row 301] signup from a non-public source address: the network rung cannot count it — check TRUST_PROXY covers the proxy');
    }

    if (fired.length > 0) {
      await prisma.signupAttempt.update({ where: { id: attempt.id }, data: { outcome: 'REVIEW_FIRST' } });
      await prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.enforcementAction.create({
          data: {
            accountId: input.userId,
            level: 'REVIEW_FIRST',
            // One hold; every signal that fired is in the evidence; a device is the stronger reason.
            reasonCode: fired[0]!['type'] === 'DEVICE' ? 'VELOCITY_DEVICE' : 'VELOCITY_NETWORK',
            signalsFired: fired as never,
            decidedBy: 'SYSTEM',
          },
        });
      });
      log().warn({ userId: input.userId, signals: fired.map((f) => f['type']) }, 'signup velocity breach — account enters REVIEW_FIRST');
    }
  })(); // [R048-007] the caller awaits, bounds, counts and logs a failure — nothing is swallowed here
}

/** Advisory declaration only. Settlement does not authenticate the requested phone. */
export function captureMmgPayer(
  prisma: PrismaClient,
  input: { userId: string; role: string; payerMsisdn: string; subscriptionId?: string;
    observationId?: string; observed?: boolean; backfill?: boolean },
): Promise<void> {
  return recordMmgPayerObservation(prisma, {
    ...input,
    tier: input.backfill ? 'LEGACY_UNVERIFIED' : input.observed ? 'OBSERVED_UNVERIFIED' : 'DECLARED',
    source: input.backfill ? 'BACKFILL' : input.observed ? 'AGENT_CREDIT' : 'BILLING_DECLARATION',
  });
}
