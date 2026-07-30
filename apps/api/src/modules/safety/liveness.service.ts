import type { PrismaClient, LivenessOutcome, LivenessPurpose } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { getKycProvider, type KycProvider } from '../../providers/kyc/kyc-provider';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';

// Identity Assurance (safety spec §7) — "is the person driving the account's
// approved human?" A fresh shift selfie is face-matched against the signup
// selfie (User.avatar), which the L2/KYC flow already proved against the
// government ID portrait — so the guarantee chain is ID ↔ signup-selfie
// (proven at verification) + signup-selfie ↔ shift-selfie (proven here),
// without decrypting stored documents every shift.
//
// The match rides the SAME swappable KycProvider seam as L2 (hard rule 4).
// Providers return a tri-state, and that tri-state IS the spec's §7.1 ladder:
//   approved        → PASS        (online; cached for the shift)
//   pending_manual  → BORDERLINE  (online, queued for human review)
//   rejected        → FAIL        (retry-capped; 3rd consecutive fail locks)
// Numeric thresholds (0.85/0.70) belong INSIDE adapters — nothing outside the
// provider may know which vendor or score scale exists.
//
// DORMANT until LIVENESS_REQUIRED=1 (same pattern as the other config-gated
// engines): the check endpoint and audit log work everywhere, but go-online
// only enforces freshness once the tenant flips it on.

const livenessRequired = () => process.env['LIVENESS_REQUIRED'] === '1';
const shiftHours = () => {
  const v = Number(process.env['LIVENESS_SHIFT_HOURS']);
  return Number.isFinite(v) && v > 0 ? v : 12;
};
const maxFails = () => {
  const v = Number(process.env['LIVENESS_MAX_FAILS']);
  return Number.isFinite(v) && v > 0 ? v : 3;
};
/** §7.1 — analyzer outage policy. Default FAIL_OPEN_FLAGGED: a vetted driver
 *  locked out of earning by a vendor outage is its own harm; every fail-open
 *  pass is queued for retroactive review and the outage alarms ops. */
const outagePolicy = (): 'FAIL_OPEN_FLAGGED' | 'FAIL_CLOSED' =>
  process.env['LIVENESS_ANALYZER_OUTAGE_POLICY'] === 'FAIL_CLOSED' ? 'FAIL_CLOSED' : 'FAIL_OPEN_FLAGGED';

export type MoverProfile = 'DRIVER' | 'RIDER';

/** The go-online gate (§7.1). Pure read of the profile row + env — exported
 *  standalone so the driver/rider routes enforce it without constructing a
 *  service or touching a provider. */
export function assertShiftLiveness(
  row: { lastLivenessPassAt: Date | null; livenessLockedAt: Date | null },
  now = new Date(),
): void {
  if (!livenessRequired()) return;
  if (row.livenessLockedAt) {
    throw new AppError(423, 'LIVENESS_LOCKED', 'Identity checks failed repeatedly — contact support to restore access.');
  }
  const fresh =
    row.lastLivenessPassAt != null &&
    now.getTime() - row.lastLivenessPassAt.getTime() < shiftHours() * 3_600_000;
  if (!fresh) {
    throw new AppError(428, 'LIVENESS_CHECK_REQUIRED', 'Take a quick selfie check to go online.');
  }
}

export interface LivenessCheckResult {
  checkId: string;
  outcome: LivenessOutcome;
  /** Whether this outcome permits going online right now. */
  allowedOnline: boolean;
  /** Remaining attempts before lock — only present after a FAIL. */
  attemptsLeft?: number;
}

export class LivenessService {
  private notifications: NotificationService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
    private kyc: KycProvider = getKycProvider(),
  ) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** Run one liveness check and apply its §7.1 consequences. Every check —
   *  pass or fail — is an auditable LivenessCheck row. */
  async check(input: { userId: string; profile: MoverProfile; selfieUrl: string; purpose?: LivenessPurpose }): Promise<LivenessCheckResult> {
    const purpose: LivenessPurpose = input.purpose ?? 'GO_ONLINE';
    const row =
      input.profile === 'DRIVER'
        ? await this.prisma.driver.findUnique({ where: { userId: input.userId }, select: { id: true, livenessLockedAt: true } })
        : await this.prisma.rider.findUnique({ where: { userId: input.userId }, select: { id: true, livenessLockedAt: true } });
    if (!row) throw new NotFoundError(input.profile === 'DRIVER' ? 'Driver' : 'Rider', input.userId);
    if (row.livenessLockedAt) {
      // No point burning provider calls — only ops review clears a lock.
      throw new AppError(423, 'LIVENESS_LOCKED', 'Identity checks failed repeatedly — contact support to restore access.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { avatar: true, selfieCapturedAt: true },
    });
    if (!user?.avatar || !user.selfieCapturedAt) {
      throw new AppError(400, 'SELFIE_REQUIRED', 'Take your profile selfie first — the identity check compares against it.');
    }

    let outcome: LivenessOutcome;
    try {
      const res = await this.kyc.verifyIdentity({
        userId: input.userId,
        idDocumentUrl: user.avatar, // the reference face (already ID-proven at L2)
        selfieUrl: input.selfieUrl,
      });
      outcome = res.status === 'approved' ? 'PASS' : res.status === 'rejected' ? 'FAIL' : 'BORDERLINE';
    } catch (err) {
      outcome = outagePolicy() === 'FAIL_CLOSED' ? 'ERROR_FAIL_CLOSED' : 'ERROR_FAIL_OPEN';
      log().error({ err, userId: input.userId, policy: outagePolicy() }, 'liveness analyzer outage — applying tenant outage policy');
      await notifyAdmins(this.prisma, this.notifications, {
        title: 'Liveness analyzer outage',
        body: `Face-match provider errored during a ${purpose} check. Policy applied: ${outagePolicy()}. Investigate the provider.`,
        data: { kind: 'liveness_outage', userId: input.userId, policy: outagePolicy() },
      }).catch(() => {});
    }

    const reviewRequired = outcome === 'BORDERLINE' || outcome === 'ERROR_FAIL_OPEN' || purpose === 'RIDER_REPORTED';
    const check = await this.prisma.livenessCheck.create({
      data: { userId: input.userId, profile: input.profile, purpose, selfieUrl: input.selfieUrl, outcome, reviewRequired },
    });

    // §7.1 consequences on the mover profile row.
    const allowedOnline = outcome === 'PASS' || outcome === 'BORDERLINE' || outcome === 'ERROR_FAIL_OPEN';
    const now = new Date();
    if (allowedOnline) {
      const data = { lastLivenessPassAt: now };
      if (input.profile === 'DRIVER') await this.prisma.driver.update({ where: { id: row.id }, data });
      else await this.prisma.rider.update({ where: { id: row.id }, data });
    }

    if (reviewRequired) {
      const why =
        outcome === 'BORDERLINE'
          ? 'Borderline face-match — compare the shift selfie against the profile side-by-side.'
          : outcome === 'ERROR_FAIL_OPEN'
            ? 'Analyzer outage fail-open — retroactively review this shift selfie.'
            : 'A rider reported "this isn\'t my driver" — review immediately.';
      await notifyAdmins(this.prisma, this.notifications, {
        title: 'Liveness review needed',
        body: why,
        data: { kind: 'liveness_review', livenessCheckId: check.id, userId: input.userId, outcome },
      }).catch(() => {});
    }

    let attemptsLeft: number | undefined;
    if (outcome === 'FAIL') {
      // Consecutive fails, newest first, including this one.
      const recent = await this.prisma.livenessCheck.findMany({
        where: { userId: input.userId, profile: input.profile },
        orderBy: { createdAt: 'desc' },
        take: maxFails(),
        select: { outcome: true },
      });
      let consecutive = 0;
      for (const r of recent) {
        if (r.outcome === 'FAIL') consecutive += 1;
        else break;
      }
      attemptsLeft = Math.max(0, maxFails() - consecutive);
      if (consecutive >= maxFails()) {
        // Locked: cannot go online, forced off NOW, ops queue + "contact
        // support" — the account may be shared/sold (the exact abuse §7 exists
        // to stop), so a human decides, never a retry loop.
        const data = { livenessLockedAt: now, isOnline: false, isAvailable: false };
        if (input.profile === 'DRIVER') await this.prisma.driver.update({ where: { id: row.id }, data });
        else await this.prisma.rider.update({ where: { id: row.id }, data });
        await notifyAdmins(this.prisma, this.notifications, {
          title: 'Liveness lock — repeated face-match failures',
          body: `A ${input.profile.toLowerCase()} failed ${consecutive} consecutive identity checks and is locked from going online. Review the check history before clearing.`,
          data: { kind: 'liveness_locked', userId: input.userId, livenessCheckId: check.id },
        }).catch(() => {});
        await this.notifications.send({
          userId: input.userId,
          type: 'SAFETY',
          title: 'Identity check failed',
          body: 'We could not confirm your identity. Contact support to restore access.',
          data: { kind: 'liveness_locked' },
        });
      }
    }

    return { checkId: check.id, outcome, allowedOnline, ...(attemptsLeft !== undefined ? { attemptsLeft } : {}) };
  }
}
