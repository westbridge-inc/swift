import type { PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// How long a vendor has to answer, and the ONE place that decides it.
//
// The behaviour itself already exists and works: `auto-cancel` is enqueued at
// order creation and `autoCancelUnresponsiveOrder` cancels an order the vendor
// never answered. What did NOT exist was any connection between that deadline
// and `order_auto_reject_minutes` — a PlatformConfig key seeded since the
// beginning, read by nothing, and rendered by the admin config page as an
// editable field labelled "Order Auto-Reject (min)".
//
// So the dashboard presented a working control for a value that was actually
// pinned to the VENDOR_RESPONSE_SLA_MINUTES environment variable. An operator
// could change the field, see it save, and change nothing. This makes it true.
// ---------------------------------------------------------------------------

/** The PlatformConfig key the admin config page edits. */
export const AUTO_REJECT_KEY = 'order_auto_reject_minutes';

/** The shipped default, used when neither config nor env supplies one. */
export const DEFAULT_VENDOR_RESPONSE_SLA_MINUTES = 10;

/**
 * Minutes a vendor has to accept before the order auto-cancels.
 *
 * Precedence: PlatformConfig → env → code default.
 *
 * **This deliberately FAILS SAFE rather than fail-closed.** A missing, zero or
 * unparseable config falls back rather than disabling the deadline, because
 * "no deadline" means orders hang in PENDING forever and a customer waits with
 * no answer. A dead config row must never be able to break the safety net it
 * was added to tune.
 *
 * Bounded to a sane range so a typo (0.5, or 100000) cannot either cancel
 * orders out from under a busy kitchen or disable the deadline by inflation.
 */
/**
 * The moment the vendor's response window closes for THIS order — the same
 * deadline the auto-cancel job enforces (enqueued at placement with a delay of
 * hold window + SLA), so the vendor's accept-clock drains toward the real
 * cut-off instead of one the client invented. Null once the order is no
 * longer awaiting the vendor: a clock on an accepted order would be a lie.
 *
 * `holdMs` is `holdWindowMs() ?? 0` — the auto-cancel delay includes the hold
 * window whenever LIFECYCLE_V2 is on, held order or not, so this does too.
 */
export function vendorRespondBy(
  order: { status: string; placedAt: Date | null; createdAt: Date },
  opts: { slaMinutes: number; holdMs: number },
): Date | null {
  if (order.status !== 'PENDING') return null;
  const start = order.placedAt ?? order.createdAt;
  return new Date(start.getTime() + opts.holdMs + opts.slaMinutes * 60_000);
}

export async function vendorResponseSlaMinutes(prisma: PrismaClient): Promise<number> {
  const envFallback = Number(
    process.env['VENDOR_RESPONSE_SLA_MINUTES'] ?? DEFAULT_VENDOR_RESPONSE_SLA_MINUTES,
  );
  const fallback = clampSla(envFallback) ?? DEFAULT_VENDOR_RESPONSE_SLA_MINUTES;

  try {
    const row = await prisma.platformConfig.findUnique({ where: { key: AUTO_REJECT_KEY } });
    if (!row) return fallback;
    const configured = clampSla(Number(row.value));
    if (configured == null) {
      log().warn({ key: AUTO_REJECT_KEY, value: row.value }, 'auto-reject config out of range — using fallback');
      return fallback;
    }
    return configured;
  } catch (err) {
    // The deadline must survive a config read failing. Scheduling the cancel
    // late is recoverable; not scheduling it at all is not.
    log().warn({ err }, 'auto-reject config read failed — using fallback');
    return fallback;
  }
}

/** 1 minute to 24 hours. Returns null for anything outside that. */
function clampSla(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < 1 || value > 1440) return null;
  return value;
}
