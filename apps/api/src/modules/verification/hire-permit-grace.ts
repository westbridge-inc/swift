/**
 * [VERIFY-DOCS · owner rulings 6 Oct 2026, ~20:25 and ~21:25 GYT] THE HIRE-CAR PERMIT SPLIT.
 *
 * The single `hire_car_permit` becomes the two licences a Guyana taxi actually holds: the
 * PERSON's Hire Car Driver's Licence (s.80, about 3 years) and the CAR's yearly hire licence
 * (s.79, exhibited on the car).
 *
 * [Owner ruling 15 Oct 2026 ~04:25Z, criminal-liability decisions] NO GRACE. The 6 Oct 60-day
 * window (an approved permit counting as both licences) is REMOVED: no driver goes online, or is
 * offered work, without BOTH licences on file and approved (abettor risk, MVRTA s.80 + SJ(O)A s.19).
 * The permit never stands in for either licence (evidence.ts). A driver who holds only the permit is
 * taken offline and told exactly which licence to upload (VerificationService.hireLicenceSweep, run
 * daily and at every API boot: hire-licence-boot.ts).
 *
 * The switch-over moment is still recorded once per environment (`ensureHireSplitStarted`, at boot,
 * never moved afterwards): it keys the one "upload your hire licences" notice a driver gets. It grants
 * nothing.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { HIRE_DRIVER_LICENCE_DOC_TYPE, HIRE_PERMIT_DOC_TYPE, HIRE_VEHICLE_LICENCE_DOC_TYPE } from './doc-registry';

type Db = Prisma.TransactionClient | PrismaClient;

// The three type names are registry text (DOC-INV-2): the permit, the person's Hire Car Driver's Licence
// (PERSONAL) and the car's yearly hire licence (VEHICLE). Re-exported for this module's callers.
export { HIRE_DRIVER_LICENCE_DOC_TYPE, HIRE_PERMIT_DOC_TYPE, HIRE_VEHICLE_LICENCE_DOC_TYPE };
export const HIRE_SPLIT_DOC_TYPES: readonly string[] = [HIRE_DRIVER_LICENCE_DOC_TYPE, HIRE_VEHICLE_LICENCE_DOC_TYPE];
/** PlatformConfig key holding `{ startedAt }` — written once, at the first boot of the split. */
export const HIRE_SPLIT_STARTED_KEY = 'documents.hire_car_split_started_at';

/** When the split took effect on this environment, or null if it has not. */
export async function hireSplitStartedAt(db: Db): Promise<Date | null> {
  const row = await db.platformConfig.findUnique({ where: { key: HIRE_SPLIT_STARTED_KEY }, select: { value: true } });
  const raw = (row?.value as { startedAt?: unknown } | null | undefined)?.startedAt;
  if (typeof raw !== 'string') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Record the switch-over once. A later boot never moves it (the notice it keys is sent once per switch-over, not per restart). */
export async function ensureHireSplitStarted(db: PrismaClient, now: Date = new Date()): Promise<Date> {
  const existing = await hireSplitStartedAt(db);
  if (existing) return existing;
  try {
    await db.platformConfig.create({ data: { key: HIRE_SPLIT_STARTED_KEY, value: { startedAt: now.toISOString() } } });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    // Another node won the unique-key race. Its persisted moment stands.
  }
  const persisted = await hireSplitStartedAt(db);
  if (!persisted) throw new Error('The hire-car licence transition start was not persisted.');
  return persisted;
}
