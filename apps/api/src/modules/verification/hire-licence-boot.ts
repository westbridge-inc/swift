/**
 * [Owner ruling 15 Oct 2026 ~04:25Z · no grace] The hire-licence sweep, once at every API boot.
 *
 * The 60-day grace is removed: a taxi driver online on the old hire-car permit alone must stop
 * receiving offers the moment this code runs, not at the next 06:00 document sweep. Dispatch picks
 * candidates from online drivers and re-checks documents only at the claim, so the sweep takes such a
 * driver offline here (VerificationService.hireLicenceSweep: idempotent, safe on every replica).
 *
 * Never fatal: a failed run is logged and the daily sweep repeats it; it must not hold the API's
 * readiness (server.ts calls it after the boot contracts are complete).
 */
import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';

export interface HireLicenceBootDeps {
  prisma: PrismaClient;
  io: Server;
  log: { warn: (...args: never[]) => void; info: (...args: never[]) => void };
}

export async function runHireLicenceSweepAtBoot(deps: HireLicenceBootDeps): Promise<void> {
  try {
    const { VerificationService } = await import('./verification.service');
    const { NotificationService } = await import('../notification/notification.service');
    const { getKycProvider } = await import('../../providers/kyc/kyc-provider');
    const verification = new VerificationService(deps.prisma, new NotificationService(deps.prisma, deps.io), getKycProvider());
    const drivers = await verification.hireLicenceSweep();
    if (drivers > 0) (deps.log.info as (obj: object, msg: string) => void)({ drivers }, 'documents: hire-licence sweep at boot');
  } catch (err) {
    (deps.log.warn as (obj: object, msg: string) => void)({ err }, 'documents: hire-licence sweep at boot failed; the daily document sweep repeats it');
  }
}
