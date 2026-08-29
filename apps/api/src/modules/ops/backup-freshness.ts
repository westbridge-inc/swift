import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Has a backup actually happened lately?
//
// `deploy/backup.sh` writes `last_backup_at` (and `last_backup_offsite`) into
// platform_config after a dump it has verified. This reads that heartbeat.
//
// The failure this exists to catch is not a backup that errors loudly — it is
// a backup that quietly stops: a timer that was never installed, a disk that
// filled, a credential that expired. Nothing looks wrong until the day the
// file is needed and there is no file. A backup nobody is watching is a belief.
// ---------------------------------------------------------------------------

export const LAST_BACKUP_KEY = 'last_backup_at';
export const LAST_BACKUP_OFFSITE_KEY = 'last_backup_offsite';

/** Hours before an absent backup is an incident. A day of lost orders is the
 *  most this policy tolerates; tune with BACKUP_MAX_AGE_HOURS. */
export const DEFAULT_MAX_AGE_HOURS = 26; // 24h cadence + 2h of slack for a slow run

export interface BackupFreshness {
  /** True when a page should be raised. */
  stale: boolean;
  /** Hours since the last verified backup; null when there has never been one. */
  ageHours: number | null;
  /** False when the last backup never left the machine it protects. */
  offsite: boolean;
  /** Human-readable, safe to put straight into an alert body. */
  reason: string;
}

/**
 * Read the heartbeat and decide whether to page.
 *
 * Two distinct alarms, deliberately not collapsed into one:
 *   - NEVER RUN / TOO OLD — there is no recent restorable copy at all.
 *   - RAN BUT NOT OFFSITE — a copy exists, on the machine it protects. One
 *     dead disk still loses everything. This is the quieter, more seductive
 *     failure, because the operator has seen a backup succeed.
 */
export async function checkBackupFreshness(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<BackupFreshness> {
  const maxAge = Number(process.env['BACKUP_MAX_AGE_HOURS'] ?? DEFAULT_MAX_AGE_HOURS);
  const maxAgeHours = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : DEFAULT_MAX_AGE_HOURS;

  const rows = await prisma.platformConfig.findMany({
    where: { key: { in: [LAST_BACKUP_KEY, LAST_BACKUP_OFFSITE_KEY] } },
  });
  const last = rows.find((r) => r.key === LAST_BACKUP_KEY);
  const offsite = rows.find((r) => r.key === LAST_BACKUP_OFFSITE_KEY)?.value === true;

  if (!last) {
    return {
      stale: true,
      ageHours: null,
      offsite: false,
      reason: 'No backup has ever been recorded. Nothing restorable exists.',
    };
  }

  const at = new Date(String(last.value).replace(/^"|"$/g, ''));
  if (Number.isNaN(at.getTime())) {
    // An unreadable timestamp is treated as stale. Erring toward a false alarm
    // is correct here: the opposite error is silence about missing backups.
    return { stale: true, ageHours: null, offsite, reason: 'The backup heartbeat is unreadable.' };
  }

  const ageHours = (now.getTime() - at.getTime()) / 3_600_000;

  if (ageHours > maxAgeHours) {
    return {
      stale: true,
      ageHours,
      offsite,
      reason: `The last verified backup was ${Math.floor(ageHours)}h ago (limit ${maxAgeHours}h). Backups have stopped.`,
    };
  }

  if (!offsite) {
    return {
      stale: true,
      ageHours,
      offsite: false,
      reason:
        'Backups are running but staying on the server they protect. One disk failure loses the database and every backup of it. Set BACKUP_BUCKET.',
    };
  }

  return {
    stale: false,
    ageHours,
    offsite: true,
    reason: `Last verified offsite backup ${Math.floor(ageHours)}h ago.`,
  };
}
