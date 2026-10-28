import { VENDOR_MMG_DESTINATION_CLEARED } from '../../utils/store-mmg';
import { ACCOUNT_CLOSURE_MESSAGE, ACCOUNT_CLOSURE_SUBJECT, ACCOUNT_ERASURE_CUTOFF } from './account-closure';
import { deidentifyCaseRecords, deidentifyProfiles, deidentifySafetyRecords, eraseOwedRowsInTransaction, retireCardsAndSessions } from './erasure-coverage';
import { eraseUserDevices } from '../../lib/owner-rls';
import { closeOpenMmgStagesFor } from '../integrity/money-surface';
import { eraseMoverObjects } from './mover-object-erasure';
import { exportPersonalData } from './data-export';
import { eraseLivenessSelfies, eraseUnclaimedUploads, forgetErasedFingerprints } from './upload-erasure';
import { NotificationService, notifyAdmins, tenantOfUser } from '../notification/notification.service';
import { lockIdentityAuthority } from '../integrity/identity-review';
import {
  openAvatarErasureObligationIds,
  owedPublicPhotoCount,
  queueStorageOrphan,
  recordStorageOrphan,
  retryStorageOrphan,
  retryStorageOrphans,
} from '../../lib/storage-orphans';
import { queuePortfolioPhotoDeletions } from '../services/portfolio-photos';
import { queueStoresPhotoErasure } from '../vendor/store-photos';
import { PUBLIC_PHOTO_ACCOUNT_DELETION, PUBLIC_PHOTO_DELETE_REASONS } from '../../utils/public-photo-deletion';
import { shredUnlessHeld, writeDeletionReceipt, NOTHING_STORED } from '../verification/purge-receipt';
import { investigationHoldRevisitBy } from '../verification/investigation-hold';
import { identityReviewOpenFor } from '../verification/investigation-hold-core';
import type { FastifyInstance } from 'fastify';
import type { Prisma, ServiceJobStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { bindTenantTransaction } from '../../plugins/prisma';
import { runAsSystem } from '../../plugins/tenant-context';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { disconnectUserSockets } from '../../utils/socket-revocation';
import { enumerateSafetyHolds, openSafetyDeletionHold } from '../safety/deletion-hold';
import { partnerObligations, verdictFor, refusalMessage, windDownPartner } from './partner-wind-down';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { isOwnedAvatarKey } from '../verification/object-authority';

// Account erasure closes authority before storage work, preserves financial and
// legal records, and de-identifies the account. The exact phone tombstone is a
// durable retry marker consumed by the retention worker. Direct-payment earnings
// never prevent erasure; live work and open cash obligations do. Business and
// advertiser self-service requests enter the support queue for closure handling.

// A closed order is safe to leave behind; anything else is in-flight and must
// finish (or be cancelled) before the customer can erase themselves.
const TERMINAL_ORDER = TERMINAL_ORDER_STATUSES; // ONE definition [order/order-status.ts]
const TERMINAL_SERVICE_JOB: ServiceJobStatus[] = ['COMPLETED', 'CANCELLED'];

export { ACCOUNT_CLOSURE_SUBJECT } from './account-closure';
/** The server-written record that a closure request was confirmed in the app
 *  (behind the deletion step-up). Anyone can type the subject into a support
 *  ticket; only the confirmed request writes this record, so support completes
 *  only a ticket that carries it. */
export const ACCOUNT_CLOSURE_CONFIRMED = 'ACCOUNT_CLOSURE_CONFIRMED_IN_APP';

/** The server, not a navigation flag or active role, chooses the business
 *  closure flow: anyone who owns a store or belongs to an advertiser closes
 *  through a request the support team completes, keeping sign-in until
 *  listings, campaigns and obligations are resolved. The profile reports the
 *  same answer so the app's confirmation copy matches what Delete does. */
export async function closesByRequest(
  db: Pick<Prisma.TransactionClient, 'vendorOwner' | 'advertiserMember'>, userId: string, roles: readonly string[],
): Promise<boolean> {
  return roles.includes('VENDOR_OWNER')
    || !!await db.vendorOwner.findUnique({ where: { userId }, select: { id: true } })
    // [ads security] an open, unaccepted team invitation is not a membership
    || !!await db.advertiserMember.findFirst({ where: { userId, acceptedAt: { not: null } }, select: { advertiserId: true } });
}

export class AccountService {
  constructor(private app: Pick<FastifyInstance, 'prisma' | 'io' | 'log'>) {}

  /** DPA right of access + portability: a copy of the person's own data.
   *  [Row 331 (b)] Every category of the export register, paged, never cut silently (data-export.ts). */
  async exportData(userId: string) {
    return exportPersonalData(this.app.prisma, userId);
  }

  private async closureTicket(tx: Prisma.TransactionClient, userId: string) {
    const where = { userId, category: 'ACCOUNT' as const, subject: ACCOUNT_CLOSURE_SUBJECT, status: { in: ['OPEN' as const, 'IN_PROGRESS' as const] } };
    const ticket = await tx.supportTicket.findFirst({ where, orderBy: { createdAt: 'desc' } })
      ?? await tx.supportTicket.create({ data: {
        userId, category: 'ACCOUNT', subject: ACCOUNT_CLOSURE_SUBJECT,
        message: ACCOUNT_CLOSURE_MESSAGE,
      } });
    // Same transaction as the request: the confirmation and its ticket commit
    // together. One record per ticket; a repeated request reuses it.
    const confirmed = await tx.auditLog.findFirst({
      where: { userId, action: ACCOUNT_CLOSURE_CONFIRMED, entity: 'SupportTicket', entityId: ticket.id }, select: { id: true },
    });
    if (!confirmed) {
      await tx.auditLog.create({ data: { userId, action: ACCOUNT_CLOSURE_CONFIRMED, entity: 'SupportTicket', entityId: ticket.id } });
    }
    return ticket;
  }

  private async closureReceipt(userId: string, ticketId: string) {
    try {
      await notifyAdmins(this.app.prisma, new NotificationService(this.app.prisma, this.app.io), {
        tenantId: await tenantOfUser(this.app.prisma, userId),
        title: 'Account closure requested', body: 'An in-app closure request needs review in the support queue.',
        data: { kind: 'support_ticket', ticketId },
      });
    } catch (error) {
      this.app.log.error({ err: error, ticketId }, 'Closure notification failed; support ticket remains open');
    }
    return { deleted: false, status: 'CLOSURE_REQUESTED' as const, ticketId,
      message: 'Your account closure request is received. Track it in Get help. Keep access while the team resolves listings, campaigns and any outstanding obligations.' };
  }

  /** The existing support queue owns the human business wind-down. */
  async requestClosure(userId: string) {
    const ticket = await this.app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
      if (!user || user.status !== 'ACTIVE') throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
      return this.closureTicket(tx, userId);
    });
    return this.closureReceipt(userId, ticket.id);
  }

  /** DPA right to erasure. Idempotent guards; crypto-shred is irreversible. */
  async deleteAccount(userId: string, selfServe = false) {
    const prisma = this.app.prisma;
    const preflight = await prisma.$transaction(async (tx) => {
      // Service-job creation, provider profile changes and verification events
      // use this same authority row. Therefore either the active job commits
      // first and blocks deletion, or deletion deactivates the account/profile
      // first and the hire fails its live re-check.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE /* account-deletion-provider-authority */
      `;
      if (!locked[0]) throw new AppError(404, 'NOT_FOUND', 'Account not found');
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, phone: true, roles: true, status: true, avatar: true, tenantId: true },
      });
      const queueAvatarBeforePointerClear = async () => {
        if (!user.avatar) return null;
        return queueStorageOrphan(tx, {
          key: user.avatar,
          reason: isOwnedAvatarKey(user.avatar, userId)
            ? 'ACCOUNT_DELETION_DELETE_PENDING'
            : 'ACCOUNT_AVATAR_AUTHORITY_UNPROVEN',
          userId,
          tenantId: user.tenantId,
        });
      };
      // [IMAGES-E2E · REVIEW-F S2-1] The provider's portfolio photos (they can show a customer's
      // home or people) go with the account: each Swift-kept photo's deletion row is written with
      // the pointer clear, under this lock; the objects are deleted after the commit.
      const queuePortfolioBeforePointerClear = async (): Promise<void> => {
        const provider = await tx.serviceProvider.findUnique({ where: { userId }, select: { id: true, portfolioPhotos: true } });
        if (!provider || provider.portfolioPhotos.length === 0) return;
        await queuePortfolioPhotoDeletions(
          tx, { id: provider.id, userId }, user.tenantId, provider.portfolioPhotos, PUBLIC_PHOTO_ACCOUNT_DELETION,
        );
        await tx.serviceProvider.update({ where: { id: provider.id }, data: { portfolioPhotos: [] } });
      };
      // [IMAGES-E2E PR4] The photos of the stores this person owns (logo, cover, sections, items:
      // they can show people) go too, the same way: deletion rows first, then the addresses cleared.
      const queueStorePhotosBeforePointerClear = async (): Promise<void> => {
        const stores = await tx.vendor.findMany({ where: { owner: { userId } }, select: { id: true } });
        if (stores.length > 0) await queueStoresPhotoErasure(tx, stores.map((v) => v.id), PUBLIC_PHOTO_ACCOUNT_DELETION);
      };
      const revokeAccessBeforeCleanup = async () => {
        await tx.session.deleteMany({ where: { userId } });
        // [item 20] An admin's closure or the retry job acts for someone else: the narrow erase action (owner wall).
        await eraseUserDevices(tx, userId);
        // [S2-29 · REVIEW-F 18 Oct] Work an approval still owes the person (the trial decision) goes with the
        // account, under this lock: a row not yet claimed never runs (a claimed one meets the tail's own barrier,
        // verification.service openForOwedWork), and the row's userId never
        // outlives the erasure (a drain that already claimed a row closes nothing: its writes are updateMany).
        await tx.verificationDecisionOutbox.deleteMany({ where: { userId } });
        // [COORD 18 Oct 23:28Z · REVIEW-F #1879 §4] Notices, staged money-setting commands, finished mover
        // revocations, unheld safety check-in deliveries, renewal reminders and staff permissions (erasure-coverage.ts).
        await eraseOwedRowsInTransaction(tx, userId);
      };
      if (user.phone === `deleted:${userId}`) {
        // [REPORT-022 F-022-11/21] A completed-looking deletion is NOT proof no
        // late write landed — fall through and RE-SWEEP (every purge step is
        // idempotent), instead of short-circuiting on the marker.
        await tx.verificationDocument.updateMany({ where: { userId, purgedAt: null }, data: { retentionExpiresAt: new Date() } });
        const avatarOrphan = await queueAvatarBeforePointerClear();
        if (avatarOrphan) await tx.user.update({ where: { id: userId }, data: { avatar: null } });
        await queuePortfolioBeforePointerClear();
        await queueStorePhotosBeforePointerClear();
        await revokeAccessBeforeCleanup();
        return { resweep: true, hold: null, avatarOrphanId: avatarOrphan?.id ?? null };
      }
      if (user.status !== 'ACTIVE' && user.status !== 'DEACTIVATED') {
        throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active and must be closed through Support.');
      }

      // The server, not a navigation flag or active role, chooses the business
      // closure flow. Keep sign-in until the support team resolves obligations.
      if (selfServe && await closesByRequest(tx, userId, user.roles)) {
        const ticket = await this.closureTicket(tx, userId);
        return { closureTicketId: ticket.id, hold: null, avatarOrphanId: null };
      }

      // Checkout locks these same vendor rows before its live eligibility read.
      // Closing commerce under this lock prevents a new order after the census.
      await tx.$queryRaw`
        SELECT v.id FROM vendors v JOIN vendor_owners o ON o.id = v."ownerId"
        WHERE o."userId" = ${userId} ORDER BY v.id FOR UPDATE OF v
      `;

      const [inFlightOrders, inFlightServiceJobs] = await Promise.all([
        tx.order.count({ where: { status: { notIn: TERMINAL_ORDER }, OR: [
          { customerId: userId }, { rider: { userId } }, { driver: { userId } }, { vendor: { owner: { userId } } },
        ] } }),
        tx.serviceJob.count({
          where: {
            status: { notIn: TERMINAL_SERVICE_JOB },
            OR: [{ customerId: userId }, { provider: { userId } }],
          },
        }),
      ]);
      // Read the cash census after the live-work snapshot. If goods return
      // between these reads, their terminal status cannot hide customer cash
      // that the rider still holds. Otherwise the earlier snapshot blocks
      // closure while the order is still active.
      // Profile ownership, not the active role, defines obligations. Switching
      // to customer mode must never hide cash or live mover work.
      const obligations = await partnerObligations(tx, userId);
      const verdict = verdictFor(obligations);
      if (!verdict.clear) {
        throw new AppError(409, 'PARTNER_OBLIGATIONS', refusalMessage(verdict.blockers, obligations));
      }
      if (inFlightOrders > 0) {
        throw new AppError(409, 'ACTIVE_ORDERS', 'Finish or cancel your active orders and jobs before deleting your account. For a job already collected, finish the handover or open Get help to resolve it.');
      }
      if (inFlightServiceJobs > 0) {
        throw new AppError(409, 'ACTIVE_SERVICE_JOBS', 'Finish or cancel your active service jobs before deleting your account.');
      }

      // [AG-XF-013] The safety obligations this person is currently inside.
      //
      // Enumerated HERE — inside the transaction, after the FOR UPDATE above —
      // so an alert raised concurrently with a deletion is either seen or
      // waits behind the lock, never interleaved with the purge.
      //
      // A hold does NOT refuse the deletion. Refusing would hand an abuser a
      // reason to keep an account alive and a malicious reporter a way to
      // block someone's erasure indefinitely; both are named in the spec as
      // the wrong extremes. The deletion proceeds in full and only the minimum
      // response authority is escrowed, encrypted, with a purge deadline.
      const holds = await enumerateSafetyHolds(tx, userId);
      const hold = holds.reasons.length > 0 ? await openSafetyDeletionHold(tx, userId, holds) : null;

      // Cut public/action authority before any fallible retention work. The
      // relational ACTIVE check is authoritative; the profile flag is a second
      // fail-closed barrier for old clients and background consumers.
      // Commit the outstanding document obligations and exact erasure marker
      // WITH the cutoff. The reaper consumes that marker under this user lock;
      // it cannot retire a newly due document as ordinary image retention.
      // Status alone is insufficient: a later admin ban can replace it. Safety
      // escrow above has already captured any needed contact authority.
      await tx.verificationDocument.updateMany({ where: { userId, purgedAt: null }, data: { retentionExpiresAt: new Date() } });
      await tx.serviceProvider.updateMany({ where: { userId }, data: { isVerified: false } });
      // Marked wound down with the cutoff, so no billing repair or fee payment
      // can reopen a closed account's store (it reopens billing holds only).
      await tx.vendor.updateMany({ where: { owner: { userId } }, data: { status: 'SUSPENDED', acceptingOrders: false, isCurrentlyOpen: false, suspensionSource: 'WIND_DOWN', ...VENDOR_MMG_DESTINATION_CLEARED } });
      await closeOpenMmgStagesFor(tx, (await tx.vendor.findMany({ where: { owner: { userId } }, select: { id: true } })).map((v) => v.id));
      const avatarOrphan = await queueAvatarBeforePointerClear();
      await queuePortfolioBeforePointerClear();
      await queueStorePhotosBeforePointerClear();
      // [row 622] The tombstone (the exact erasure marker) BEFORE the cleanup, in this same transaction: the
      // owner wall's erase actions (devices, notices) refuse any account that does not carry it. Nothing the
      // cleanup runs reads users.status or users.phone (owner-wall-erase-guard.test.ts pins it), and the
      // commit is the same either way.
      await tx.user.update({
        where: { id: userId },
        data: { status: 'DEACTIVATED', phone: `deleted:${userId}`, avatar: null },
      });
      await revokeAccessBeforeCleanup();
      // [erasure exceptions] The erasure's own record of its cut-off, committed with the marker. audit_logs is
      // immutable to app logins; the database's erasure exceptions (swift_erased_person) require this row too.
      await tx.auditLog.create({ data: { userId, action: ACCOUNT_ERASURE_CUTOFF, entity: 'User', entityId: userId } });
      return { hold, avatarOrphanId: avatarOrphan?.id ?? null };
    });
    if ('closureTicketId' in preflight && preflight.closureTicketId) return this.closureReceipt(userId, preflight.closureTicketId);
    if ((preflight as { resweep?: boolean }).resweep) {
      this.app.log.info({ userId }, 'account deletion re-sweep: purging any late writes');
    }

    // The status commit above is the authority cut-off. Evict every already-
    // open realtime transport immediately after that commit so a deleted user
    // cannot keep receiving order/chat/vendor events while the retention purge
    // continues. Production's Redis adapter propagates this across API nodes;
    // the socket expiry timer remains the fail-closed upper bound if transport
    // cleanup itself is temporarily unavailable.
    try {
      disconnectUserSockets(this.app.io, userId);
    } catch (error) {
      this.app.log.warn({ err: error, userId }, 'account deletion socket cleanup failed');
    }

    // Wind down commercial access without moving money. A failure propagates;
    // the API returns a pending receipt and the retention sweep retries the
    // durable marker even though the person can no longer sign in.
    const wound = await windDownPartner(prisma, userId);
    if (wound && (wound.vendorsClosed || wound.itemsWithdrawn || wound.staffRevoked || wound.subscriptionsCancelled)) {
      this.app.log.info({ userId, ...wound }, '[5.1.1v] partner wound down on account deletion');
    }

    // [COORD 19 Oct 03:46Z] Every saved card leaves service (REVOKED, unsent charges closed; the row is PT-1
    // frozen) and card sessions that moved no money go; payment evidence stays (settlement history, §6).
    await retireCardsAndSessions(prisma, userId);

    const memberships = await prisma.advertiserMember.findMany({
      where: { userId },
      select: { advertiserId: true, role: true },
    });
    for (const membership of memberships) {
      if (membership.role !== 'OWNER') continue;
      const otherOwners = await prisma.advertiserMember.count({
        where: { advertiserId: membership.advertiserId, role: 'OWNER', userId: { not: userId } },
      });
      // A co-owned company keeps running — only this person's seat goes.
      if (otherOwners > 0) continue;
      const paused = await prisma.adCampaign.updateMany({
        where: { advertiserId: membership.advertiserId, status: { in: ['LIVE', 'SCHEDULED'] } },
        data: { status: 'PAUSED', statusReason: 'Advertiser account deleted by its last owner' },
      });
      // Only APPROVED is a legal source for SUSPENDED in the §4.3 machine;
      // updateMany with the status in the predicate keeps that true without
      // needing to read-then-write.
      await prisma.advertiser.updateMany({
        where: { id: membership.advertiserId, status: 'APPROVED' },
        data: { status: 'SUSPENDED' },
      });
      await prisma.adsAuditLog.create({
        data: {
          actorUserId: userId,
          action: 'ADVERTISER_SUSPEND_ACCOUNT_DELETED',
          entityType: 'Advertiser',
          entityId: membership.advertiserId,
          reason: `Last owner deleted their Swift account; ${paused.count} campaign(s) paused.`,
        },
      });
    }
    await prisma.advertiserMember.deleteMany({ where: { userId } });
    await prisma.vendorStaff.deleteMany({ where: { userId } });

    // 1. Crypto-shred every verification document: delete the object, null the
    //    wrapped DEK (unrecoverable even from a ciphertext backup), mark purged.
    const storage = getStorageProvider();
    // [DOC-1 §9.4 · DOC-INV-14] A document under a legal hold is NOT purged by
    // erasure: it stays, due for purge the moment the hold is released (its
    // retention clock is set to now), and the deferral is written to the audit
    // trail — erasure deferred by a legal obligation is recorded, never silent.
    const deferred = await prisma.verificationDocument.updateMany({
      where: { userId, purgedAt: null, legalHoldId: { not: null } },
      data: { retentionExpiresAt: new Date() },
    });
    if (deferred.count > 0) {
      await prisma.auditLog.create({ data: {
        userId, action: 'ERASURE_DEFERRED_LEGAL_HOLD', entity: 'User', entityId: userId,
        changes: { heldDocuments: deferred.count, reason: 'DOC-1 §9.4: a legal hold blocks purge until released' },
      } });
    }
    const docs = await prisma.verificationDocument.findMany({
      where: { userId, purgedAt: null, legalHoldId: null },
      select: { id: true, fileUrl: true, docType: true, user: { select: { tenantId: true } } },
    });
    let pendingDocuments = 0;
    for (const doc of docs) {
      // [DOC-INV-7] Passing evidence closes the document with its receipt in
      // one transaction. An authority refusal or FAILED probe retains the
      // due pointer; it cannot prevent the other personal-data cleanup.
      let evidence;
      try {
        // [Row 243] Destroyed only under the person's lock while still unheld. A hold that landed
        // since the census keeps the document; the tombstone retry then defers it as held.
        const fenced = doc.fileUrl ? await shredUnlessHeld(prisma, storage, { fileKey: doc.fileUrl, userId, documentId: doc.id }, { purgedAt: null }) : NOTHING_STORED;
        if (!fenced) { pendingDocuments += 1; continue; }
        evidence = fenced;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'VERIFICATION_OBJECT_UNAVAILABLE') throw error;
        // Refusal is an unresolved obligation, never proof of destruction.
        // The retained row + due clock committed above are the retry census.
        pendingDocuments += 1;
        this.app.log.warn({ userId, documentId: doc.id }, 'account document erasure pending: object authority unavailable');
        continue;
      }
      if (evidence.probe === 'FAILED' && doc.fileUrl) {
        await recordStorageOrphan(prisma, this.app.log, { key: doc.fileUrl, reason: 'ERASURE_PURGE_PROBE_FAILED', userId, tenantId: doc.user.tenantId });
        await writeDeletionReceipt(prisma, { submissionId: doc.id, subjectId: userId, tenantId: doc.user.tenantId, docTypeCode: doc.docType, deletedBy: userId, evidence });
        pendingDocuments += 1;
        continue;
      }
      const closed = await prisma.$transaction(async (tx) => {
        // [Row 243] The close re-checks the hold under the person's row lock (placeDocLegalHoldIn takes the same lock
        // first). A hold that landed since the census keeps the record and its extracted values: that includes a
        // document whose image R24 already purged (fileUrl ''), which never enters the fence above. A document a
        // concurrent purge already closed is not closed (or receipted) twice.
        await bindTenantTransaction(tx);
        const person = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE /* verification-document-purge-authority */
        `;
        if (person.length !== 1) return false;
        // [SEC-PII · COORD] Backstop: an identity review open on the person's live group chain keeps the record.
        if (await identityReviewOpenFor(tx, userId)) return false;
        const close = await tx.verificationDocument.updateMany({
          where: { id: doc.id, userId, purgedAt: null, legalHoldId: null }, data: { purgedAt: new Date(), fileUrl: '' },
        });
        if (close.count !== 1) return false;
        // [DOC-1 Part XXV] Erasure takes the extracted VALUES with the image: shred the run DEKs (rows stay as the custody record).
        await tx.extractionRun.updateMany({ where: { submissionId: doc.id }, data: { wrappedDek: null } });
        await tx.extractedField.updateMany({ where: { submissionId: doc.id }, data: { valueCt: null } });
        await writeDeletionReceipt(tx, { submissionId: doc.id, subjectId: userId, tenantId: doc.user.tenantId, docTypeCode: doc.docType, deletedBy: userId, evidence });
        return true;
      });
      // Held (or already closed) since the census: the tombstone retry defers or skips it.
      if (!closed) pendingDocuments += 1;
    }

    const moverObjects = await eraseMoverObjects(prisma, storage, userId, this.app.log);
    pendingDocuments += moverObjects.pending;

    // [Row 331 · DSAR-ERASURE (a)] Uploads no document or mover pointer claims (the optional L2
    // ID selfie, an abandoned onboarding file) go too, with a receipt; a hold keeps them.
    const uploads = await eraseUnclaimedUploads(prisma, storage, userId, this.app.log);
    // [Row 331 (c)] Everything shredded above stops carrying its content hash, so the same
    // document uploaded later cannot find this account again (held objects keep theirs until purged).
    const fingerprints = await forgetErasedFingerprints(prisma, userId, this.app.log);
    let pendingUploads = uploads.pending + fingerprints.pending;

    // 1a. [F-024-08] The mandatory signup selfie lives in the avatar object,
    //     which is PUBLIC for the local provider. Nulling the column (step 4)
    //     leaves the object reachable — a DPA deletion-barrier breach. Delete
    //     the object here, before the column is cleared, so the census still
    //     knows the key. Only the server-issued avatar namespace of this
    //     subject proves deletion authority; unproven pointers stay censused.
    // The pointer and durable obligation were committed together under the
    // User lock in preflight. Only a provider-canonical, globally unreferenced
    // key with a confirmed-absence probe can close that exact row. A failed or
    // quarantined row keeps the account response pending.
    const avatarOrphanId = (preflight as { avatarOrphanId?: string | null }).avatarOrphanId;
    let exactAvatarObligationClosed = avatarOrphanId === null || avatarOrphanId === undefined;
    if (avatarOrphanId) {
      exactAvatarObligationClosed = await retryStorageOrphan(prisma, storage, this.app.log, avatarOrphanId);
    }

    // A standing verification worker also drains this census. This bounded
    // pass opportunistically repairs older obligations without making account
    // deletion of another person the only recovery mechanism.
    await retryStorageOrphans(prisma, storage, this.app.log).catch(() => undefined);
    const openAvatarObligations = new Set<string>();
    try {
      for (const id of await openAvatarErasureObligationIds(prisma, userId)) openAvatarObligations.add(id);
      // Upsert preserves prior provenance. If the exact row returned during
      // preflight belongs to another subject/tenant, the subject census above
      // intentionally will not find it; unless this invocation proved it
      // closed, it still blocks a truthful completion response.
      if (avatarOrphanId && !exactAvatarObligationClosed) {
        const exact = await prisma.storageOrphan.findUnique({
          where: { id: avatarOrphanId }, select: { purgedAt: true },
        }).catch(() => null);
        if (!exact?.purgedAt) openAvatarObligations.add(avatarOrphanId);
      }
    } catch (error) {
      // Failure to prove an empty global census is pending erasure, not success.
      openAvatarObligations.add(avatarOrphanId ?? `unproven-avatar-census:${userId}`);
      this.app.log.error({ err: error, userId }, 'account avatar-erasure completion census failed');
    }
    const pendingAvatarObjects = openAvatarObligations.size;

    // [IMAGES-E2E · REVIEW-F S2-1] This person's photos still owed a deletion (the portfolio queued
    // above, or one an earlier run or a take-down could not delete): deleted now; any still open
    // keeps the receipt pending, and this sweep's retry (or the standing one) finishes it.
    // Read as the named system capability: the census sees this person's rows whatever tenant
    // the request runs in (an admin-run erasure included), so "nothing owed" is never a blind spot.
    // [REVIEW-G S3-1 / DUP-AUDIT B-4] The census is a proven system-login read (#1953's proof):
    // unproven (no system login under the wall, a narrowed policy) = still pending, never "deleted".
    pendingUploads += await owedPublicPhotoCount(prisma, userId, [...PUBLIC_PHOTO_DELETE_REASONS], (id) =>
      runAsSystem('account-erasure-public-photos', () => retryStorageOrphan(prisma, storage, this.app.log, id)),
    ).catch((err: unknown) => {
      this.app.log.error({ err, userId }, 'account public-photo erasure census failed');
      return 1;
    });

    // 1b. Identity-integrity purge (trial-integrity spec Part 8, DPA 2023):
    //     the account's identity signals — hashed keys, cluster membership,
    //     and the biometric face template — are erased with the person.
    //     EXCEPTION: fraud tombstones, a founder/legal decision gated behind
    //     IntegritySettings.tombstoneRetentionEnabled (default OFF). When ON,
    //     the salted hashes + membership remain (legitimate-interest fraud
    //     prevention, the documented sole exception); the raw-embedding face
    //     template is deleted in EVERY case — it is not a hash.
    const integrity = await prisma.integritySettings.findUnique({ where: { id: 'platform' } });
    await prisma.faceTemplate.deleteMany({ where: { accountId: userId } });
    if (!integrity?.tombstoneRetentionEnabled) {
      await prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.identityKey.deleteMany({ where: { accountId: userId } });
        await tx.identityClusterMember.deleteMany({ where: { accountId: userId } });
      });
    }

    // 2. [Owner decision + coordinator ruling 2026-10-05] Ratings this person
    //    wrote, and ratings others wrote about them, stay counted — score and
    //    tags keep every rating, average and history unchanged — but free text
    //    can name or describe them and automatic redaction is unreliable, so
    //    the comment AND any reply to it are deleted, as is any queued copy of
    //    the comment. Idempotent, so a re-sweep repeats it safely.
    await prisma.rating.updateMany({
      where: {
        AND: [
          { OR: [{ raterId: userId }, { rateeId: userId }] },
          { OR: [{ comment: { not: null } }, { response: { not: null } }, { respondedBy: { not: null } }] },
        ],
      },
      data: { comment: null, response: null, respondedAt: null, respondedBy: null },
    });
    await prisma.$executeRaw`
      UPDATE rating_outbox SET payload = payload - 'comment'
      WHERE "ratingId" IN (SELECT id FROM ratings WHERE "raterId" = ${userId} OR "rateeId" = ${userId})
        AND jsonb_typeof(payload) = 'object' AND payload ? 'comment'
      /* account-erasure-review-text */
    `;

    // Sessions and push tokens were revoked atomically with authority cutoff.

    // 3. Drop precise saved locations (home/work) outright. [item 20] Through
    //    a named system capability: an admin's closure or the erasure retry job
    //    acts for someone else, and the owner wall would let it delete nothing.
    await runAsSystem('account:erasure-addresses', () => prisma.address.deleteMany({ where: { userId } }));

    // 3b. [NR-3 census gap 6] Ephemeral high-risk rows go WITH the account —
    //     recovery ID/selfie pointers, biometric liveness rows, public trip
    //     shares, third-party emergency contacts, exact-location queue/watch
    //     rows, and the cart. None has a continuing purpose once the person
    //     leaves; case-bound safety evidence lives elsewhere under its own
    //     hold rules.
    await prisma.accountRecovery.deleteMany({ where: { userId } });
    // [Row 331 (a)] The shift selfie photos first: each row goes once its photo is confirmed gone
    // (a legal hold on the person keeps both, reported as held).
    const liveness = await eraseLivenessSelfies(prisma, storage, userId, this.app.log);
    pendingUploads += liveness.pending;
    await prisma.tripShareToken.deleteMany({ where: { createdByUserId: userId } });
    await prisma.emergencyContact.deleteMany({ where: { userId } });
    await prisma.rideQueueEntry.deleteMany({ where: { customerId: userId } });
    await prisma.supplyWatch.deleteMany({ where: { customerId: userId } });
    await prisma.cart.deleteMany({ where: { customerId: userId } });
    await prisma.cartMergeReceipt.deleteMany({ where: { userId } });
    // [O-1] The Swift-bridged calls the person asked for (roles and times; never a number).
    await prisma.callSession.deleteMany({ where: { callerUserId: userId } });

    // 3c. [COORD 18 Oct 23:28Z · owner 19 Oct A/A/A] Rows that stay lose what identifies the person: profiles
    //     (vehicle, plate, location, pay link, bio), the checkout replay copy, fraud marks (phone, address key,
    //     appeal text), case and request free text, and closed, unheld safety records (location, address, notes).
    // [IMAGES-E2E · DUP-AUDIT B-2] A portfolio photo still listed here (normally none: the cut-off
    // cleared them) got its deletion row before its pointer went; deleted now, or it stays owed.
    const lateProfilePhotos = await deidentifyProfiles(prisma, userId);
    if (lateProfilePhotos.length > 0) {
      pendingUploads += await runAsSystem('account-erasure-public-photos', async () => {
        let open = 0;
        for (const id of lateProfilePhotos) if (!(await retryStorageOrphan(prisma, storage, this.app.log, id))) open += 1;
        return open;
      }).catch(() => lateProfilePhotos.length);
    }
    await deidentifyCaseRecords(prisma, userId);
    await deidentifySafetyRecords(prisma, userId);

    // 4. De-identify the account row. It stays (orders/ratings reference it for
    //    the legal retention window) but the person is stripped from it. The
    //    phone becomes a non-PII tombstone that keeps the unique constraint and
    //    frees the real number for a future signup.
    await prisma.user.update({
      where: { id: userId },
      data: {
        status: 'DEACTIVATED',
        firstName: 'Deleted',
        lastName: 'User',
        email: null,
        avatar: null,
        phone: `deleted:${userId}`,
        passwordHash: null,
        selfieCapturedAt: null,
        isPhoneVerified: false,
        isEmailVerified: false,
        lastKnownLat: null,
        lastKnownLng: null,
      },
    });

    const revisitBy = deferred.count > 0 ? await investigationHoldRevisitBy(prisma, userId) : null;
    // Everything a hold keeps is reported as kept (heldUploads = unclaimed uploads + liveness photos).
    const heldUploads = uploads.held + liveness.held;
    if (deferred.count > 0 || moverObjects.held > 0 || heldUploads > 0 || fingerprints.held > 0) {
      return {
        deleted: false, status: 'PENDING_LEGAL_HOLD' as const, heldDocuments: deferred.count, heldMoverObjects: moverObjects.held, heldUploads,
        pendingDocuments, pendingAvatarObjects, pendingUploads,
        // [SEC-PII · Privacy §6] Delayed by an open review: why (generically) and when, in the words the app shows.
        message: revisitBy
          ? `Your account is closed. Some of your documents are part of a review that is still open, so they are kept until it ends; we will look at your request again by ${revisitBy.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'long', year: 'numeric' })}. Documents required by a legal hold remain protected until the hold is released; other pending erasure will be retried automatically.`
          : 'Your account is closed. Documents required by a legal hold remain protected until the hold is released; other pending erasure will be retried automatically.',
      };
    }

    if (pendingDocuments > 0 || pendingAvatarObjects > 0 || pendingUploads > 0) {
      return {
        deleted: false, status: 'PENDING_DOCUMENT_ERASURE' as const,
        pendingDocuments, pendingAvatarObjects, pendingUploads,
        message: 'Your account is closed. Some personal-data erasure is pending; no further sign-in is needed.',
        ...(preflight.hold && { holdId: preflight.hold.holdId, holdReasons: preflight.hold.reasons }),
      };
    }

    // [AG-XF-013] The receipt names the hold when there is one. Everything the
    // person asked to be erased HAS been erased; what remains is an encrypted
    // escrow of the minimum needed to finish an emergency that was already
    // open, and it shreds itself when that emergency ends — or at `purgeBy` if
    // it never does.
    return preflight.hold
      ? { deleted: true, status: 'PENDING_SAFETY_HOLD' as const, holdId: preflight.hold.holdId, holdReasons: preflight.hold.reasons }
      : { deleted: true };
  }
}
