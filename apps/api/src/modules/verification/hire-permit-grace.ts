/**
 * [VERIFY-DOCS · owner rulings 6 Oct 2026, ~20:25 and ~21:25 GYT] THE HIRE-CAR PERMIT SPLIT.
 *
 * The single `hire_car_permit` becomes the two licences a Guyana taxi actually holds: the
 * PERSON's Hire Car Driver's Licence (s.80, about 3 years) and the CAR's yearly hire licence
 * (s.79, exhibited on the car). "Existing taxi drivers with an approved hire-car permit: 60-day
 * grace (counts as both new licences until it expires or 60 days pass, whichever first), with
 * reminders; nobody knocked offline on day one."
 *
 * When does the 60 days start? When this code first runs on an environment: the server
 * records the moment once at boot (`ensureHireSplitStarted`, never moved afterwards), so
 * staging and production each get their full window from their own switch-over. With no
 * recorded start the split has not happened there yet, and nothing is granted.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { HIRE_DRIVER_LICENCE_DOC_TYPE, HIRE_PERMIT_DOC_TYPE, HIRE_VEHICLE_LICENCE_DOC_TYPE } from './doc-registry';

type Db = Prisma.TransactionClient | PrismaClient;

// The three type names are registry text (DOC-INV-2): the permit, the person's Hire Car Driver's Licence
// (PERSONAL) and the car's yearly hire licence (VEHICLE). Re-exported for this module's callers.
export { HIRE_DRIVER_LICENCE_DOC_TYPE, HIRE_PERMIT_DOC_TYPE, HIRE_VEHICLE_LICENCE_DOC_TYPE };
export const HIRE_SPLIT_DOC_TYPES: readonly string[] = [HIRE_DRIVER_LICENCE_DOC_TYPE, HIRE_VEHICLE_LICENCE_DOC_TYPE];
export const HIRE_PERMIT_GRACE_DAYS = 60;
/** PlatformConfig key holding `{ startedAt }` — written once, at the first boot of this code. */
export const HIRE_SPLIT_STARTED_KEY = 'documents.hire_car_split_started_at';

const DAY = 86_400_000;

/** When the split took effect on this environment, or null if it has not. */
export async function hireSplitStartedAt(db: Db): Promise<Date | null> {
  const row = await db.platformConfig.findUnique({ where: { key: HIRE_SPLIT_STARTED_KEY }, select: { value: true } });
  const raw = (row?.value as { startedAt?: unknown } | null | undefined)?.startedAt;
  if (typeof raw !== 'string') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Record the switch-over once. A later boot never moves it (the window is the owner's 60 days, not 60 days from the last restart). */
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

/** The last moment an old permit still counts as the two new licences. */
export function hirePermitGraceEnd(startedAt: Date): Date {
  return new Date(startedAt.getTime() + HIRE_PERMIT_GRACE_DAYS * DAY);
}

/** The grace window's end if it is still open at `now`, else null. */
export async function openHirePermitGrace(db: Db, now: Date): Promise<Date | null> {
  const started = await hireSplitStartedAt(db);
  if (!started) return null;
  const end = hirePermitGraceEnd(started);
  return end.getTime() > now.getTime() ? end : null;
}
