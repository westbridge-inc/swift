import type { DocState, PrismaClient } from '@prisma/client';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import { log } from '../../utils/logger';
import { DOC_TRANSITIONS } from './doc-state';

/** [Row 209] The states the document machine lets EXPIRE, read from the machine itself. A lapsed row
 *  in any other state would be refused by the database (DOC_STATE_ILLEGAL), so the sweep holds it. */
export const EXPIRABLE_DOC_STATES: ReadonlySet<DocState> = new Set(
  DOC_TRANSITIONS.filter((t) => t.to === 'EXPIRED').map((t) => t.from),
);

/** Why a step of the expiry sweep did not finish. */
export type ExpiryHeldReason =
  | 'provider_reconcile' // the provider-verification heal threw
  | 'vendor_reconcile' // the vendor-activation heal threw
  | 'not_expirable' // a lapsed row whose state cannot expire: left as it is, for a person
  | 'expiry_failed' // the expiry itself failed: the row stays lapsed and is retried on the next run
  | 'effects_failed'; // expired, but a follow-up (offline, listings, vehicle, notice) failed

const ID_SAMPLE = 10;

/**
 * [Row 209] What the daily expiry sweep could not finish, so that one row never stops the rest:
 * each failure is counted and logged by document id and error class only (never a message, which
 * can carry values), and the admins are told ONCE per run. Nothing here throws.
 */
export class ExpirySweepReport {
  readonly counts: Partial<Record<ExpiryHeldReason, number>> = {};
  readonly documentIds: string[] = [];

  add(reason: ExpiryHeldReason, documentId: string | null, err?: unknown): void {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
    if (documentId && this.documentIds.length < ID_SAMPLE) this.documentIds.push(documentId);
    if (err !== undefined) {
      log().error({
        reason, documentId,
        errName: err instanceof Error ? err.name : typeof err,
        code: typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined,
      }, 'verification expiry sweep: a step failed; the sweep continued');
    }
  }

  get total(): number {
    return Object.values(this.counts).reduce((sum, n) => sum + (n ?? 0), 0);
  }

  /** One admin notice for the run (counts only), if anything was held or failed. */
  async report(prisma: PrismaClient, notifications: NotificationService, expired: number): Promise<void> {
    if (this.total === 0) return;
    const summary = Object.entries(this.counts).map(([reason, n]) => `${reason}=${n}`).join(' ');
    log().error({ counts: this.counts, documentIds: this.documentIds, expired }, 'verification expiry sweep held or failed rows; the rest of the sweep ran');
    await notifyAdmins(prisma, notifications, {
      tenantId: null,
      title: 'Document expiry needs attention',
      body: `${this.total} step(s) of today's document expiry could not finish (${summary}). Every other document was handled and the retention work ran. Failed rows are retried on the next run; a held row needs a person.`,
      data: { kind: 'ops_reaper_failed', error: `expiry sweep: ${summary}`.slice(0, 200) },
    }).catch((err: unknown) => {
      log().error({ errName: err instanceof Error ? err.name : typeof err }, 'verification expiry sweep: the admin notice failed');
    });
  }
}
