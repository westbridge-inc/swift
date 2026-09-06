import { recordStorageOrphan, retryStorageOrphans } from '../../lib/storage-orphans';
import { shredAndProbe, writeDeletionReceipt, NOTHING_STORED } from '../verification/purge-receipt';
import type { FastifyInstance } from 'fastify';
import type { ServiceJobStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { disconnectUserSockets } from '../../utils/socket-revocation';
import { enumerateSafetyHolds, openSafetyDeletionHold } from '../safety/deletion-hold';
import { partnerObligations, verdictFor, refusalMessage, windDownPartner } from './partner-wind-down';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';

// ---------------------------------------------------------------------------
// SWIFT-AUD-D9-05 — the DPA-2023 rights of access, portability and erasure,
// self-serve and in-app (previously the privacy policy pointed people at
// Support with no mechanism behind it).
//
//  • exportData  — everything we hold about the person, as portable JSON.
//  • deleteAccount — crypto-shred verification docs, revoke access, and
//    de-identify the account. Records the law REQUIRES us to keep (orders, for
//    disputes/guarantees) stay, but the person behind them is anonymised.
//
// Scope: EVERY account type the app can create.
//
// It used to be "a pure CUSTOMER account" — mover and vendor accounts closed
// through Support, because they carry payouts, live listings and staff and a
// self-delete would orphan a running catalogue. That reasoning was right about
// the risk and wrong about the remedy, and App Review names the remedy
// specifically: 5.1.1(v) requires in-app deletion for every account type an
// app can create, and pointing at Support does not satisfy it. The app has a
// Delete account button, so a driver pressing it was told to write an email.
//
// What a partner holds divides cleanly. Money in flight REFUSES — cash they
// are holding, an unconfirmed settlement, earnings owed — because erasing over
// any of it loses somebody's money, and each one ends on its own with a next
// step the person can take themselves. Everything else WINDS DOWN in the purge
// phase: storefront off sale, staff keys revoked, subscription stopped. See
// partner-wind-down.ts.
//
// [LAUNCH-2] That old scope sentence was only ever true of the `roles` array, and
// two kinds of authority deliberately live outside it: advertiser membership
// (AdvertiserMember, ads §4 — "NOT a new UserRole") and vendor staff access
// (VendorStaff). Both belong to people the role filter sees as plain
// CUSTOMERs, so both could always self-delete — leaving a LIVE ad campaign
// with no owner, and staff rows pointing at "Deleted User". Step 0b now winds
// those down. Closing MOVER and VENDOR_OWNER accounts in-app was the remaining
// half; it is done, above.
// ---------------------------------------------------------------------------

// A closed order is safe to leave behind; anything else is in-flight and must
// finish (or be cancelled) before the customer can erase themselves.
const TERMINAL_ORDER = TERMINAL_ORDER_STATUSES; // ONE definition [order/order-status.ts]
const TERMINAL_SERVICE_JOB: ServiceJobStatus[] = ['COMPLETED', 'CANCELLED'];

export class AccountService {
  constructor(private app: FastifyInstance) {}

  /** DPA right of access + portability: a copy of the person's own data. */
  async exportData(userId: string) {
    const prisma = this.app.prisma;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        email: true,
        firstName: true,
        lastName: true,
        roles: true,
        activeRole: true,
        lastMoverRole: true,
        countryCode: true,
        trustLevel: true,
        isPhoneVerified: true,
        createdAt: true,
        lastActiveAt: true,
      },
    });
    if (!user) throw new AppError(404, 'NOT_FOUND', 'Account not found');

    const [addresses, orders, ratingsGiven, serviceJobs] = await Promise.all([
      prisma.address.findMany({
        where: { userId },
        select: { label: true, addressLine1: true, addressLine2: true, city: true, latitude: true, longitude: true, createdAt: true },
      }),
      prisma.order.findMany({
        where: { customerId: userId },
        select: { orderNumber: true, orderType: true, status: true, totalAmount: true, createdAt: true, deliveredAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      prisma.rating.findMany({
        where: { raterId: userId },
        select: { score: true, comment: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
      prisma.serviceJob.findMany({
        where: { customerId: userId },
        select: { status: true, scheduledFor: true, quoteAmount: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      notice:
        'This is the personal data Swift holds about your account. Money amounts are in your local minor unit. Verification document contents are never exported — they are encrypted and access-logged.',
      account: user,
      addresses,
      orders,
      ratingsGiven,
      serviceJobs,
    };
  }

  /** DPA right to erasure. Idempotent guards; crypto-shred is irreversible. */
  async deleteAccount(userId: string) {
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
        select: { id: true, phone: true, roles: true, status: true },
      });
      if (user.status === 'DEACTIVATED' && user.phone.startsWith('deleted:')) {
        // [REPORT-022 F-022-11/21] A completed-looking deletion is NOT proof no
        // late write landed — fall through and RE-SWEEP (every purge step is
        // idempotent), instead of short-circuiting on the marker.
        return { alreadyComplete: false, resweep: true, hold: null };
      }
      if (user.status !== 'ACTIVE' && user.status !== 'DEACTIVATED') {
        throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active and must be closed through Support.');
      }

      // [Apple 5.1.1(v)] A partner closes their own account, in the app.
      //
      // This used to refuse every non-CUSTOMER role outright and point at
      // Support. The app has a Delete account button, so a driver pressing it
      // was told to write an email — which App Review names specifically as
      // not satisfying the guideline. The comment at the top of this file has
      // said so all along while nothing acted on it.
      //
      // The refusal was right about the risk and wrong about the remedy. What
      // a partner holds divides cleanly: money in flight BLOCKS (and each
      // blocker ends on its own, with a next step the person can take), and
      // everything else — a live storefront, staff keys, a subscription —
      // WINDS DOWN in the purge phase below, exactly as ad campaigns already
      // do. See partner-wind-down.ts.
      const partnerRoles = user.roles.filter((role) => role !== 'CUSTOMER');
      if (partnerRoles.length > 0) {
        const verdict = verdictFor(await partnerObligations(tx, userId));
        if (!verdict.clear) {
          throw new AppError(409, 'PARTNER_OBLIGATIONS', refusalMessage(verdict.blockers));
        }
      }

      const [inFlightOrders, inFlightServiceJobs] = await Promise.all([
        tx.order.count({ where: { customerId: userId, status: { notIn: TERMINAL_ORDER } } }),
        tx.serviceJob.count({
          where: {
            status: { notIn: TERMINAL_SERVICE_JOB },
            OR: [{ customerId: userId }, { provider: { userId } }],
          },
        }),
      ]);
      if (inFlightOrders > 0) {
        throw new AppError(409, 'ACTIVE_ORDERS', 'Finish or cancel your active orders before deleting your account.');
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
      await tx.serviceProvider.updateMany({ where: { userId }, data: { isVerified: false } });
      await tx.user.update({ where: { id: userId }, data: { status: 'DEACTIVATED' } });
      return { alreadyComplete: false, hold };
    });
    if (preflight.alreadyComplete) return { deleted: true };
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

    // 0b. [LAUNCH-2] Access that is NOT a UserRole.
    //
    //     The partner guard above filters `user.roles`, but two kinds of
    //     authority never appear there: advertiser membership is keyed on
    //     AdvertiserMember by design (ads §4 — "NOT a new UserRole"), and
    //     vendor staff access is keyed on VendorStaff. To that role filter a
    //     person running live ad campaigns, or a manager with keys to someone
    //     else's storefront, is an ordinary CUSTOMER — so they never hit the
    //     PARTNER_ACCOUNT guard and could always delete themselves. What they
    //     left behind was a LIVE campaign with no owner and vendor_staff rows
    //     pointing at "Deleted User".
    //
    //     Campaigns are PAUSED, never cancelled: pausing stops serving
    //     immediately, while cancelling would reach into refund intents and
    //     booked inventory — money movement has no business riding an erasure
    //     request. The Advertiser company row itself survives with its
    //     invoices, which are financial records under the same legal-obligation
    //     basis as the rest. This runs in the purge phase so the re-sweep
    //     repairs it, and every step is idempotent.
    // [Apple 5.1.1(v)] Close what leaving implies: a storefront off sale, staff
    // keys revoked, the subscription stopped. Taken off sale rather than
    // deleted — orders, receipts and sales history are financial records under
    // the same legal-obligation basis as everything else kept here. What must
    // stop is a customer ordering from a business that no longer has an owner.
    // Idempotent, so the re-sweep repairs a partial run; moves no money.
    const wound = await windDownPartner(prisma, userId).catch((error) => {
      this.app.log.error({ err: error, userId }, '[5.1.1v] partner wind-down failed — re-sweep will retry');
      return null;
    });
    if (wound && (wound.vendorsClosed || wound.itemsWithdrawn || wound.staffRevoked || wound.subscriptionsCancelled)) {
      this.app.log.info({ userId, ...wound }, '[5.1.1v] partner wound down on account deletion');
    }

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
    for (const doc of docs) {
      // [DOC-INV-7] Delete, shred, PROBE, and write the receipt with the purge
      // mark in one transaction. Erasure must complete for the person, so a
      // FAILED probe is recorded as FAILED and the bytes are filed as a
      // storage orphan for the retry sweep — never silently swallowed.
      const evidence = doc.fileUrl ? await shredAndProbe(prisma, storage, doc.fileUrl) : NOTHING_STORED;
      if (evidence.probe === 'FAILED' && doc.fileUrl) {
        await recordStorageOrphan(prisma, this.app.log, { key: doc.fileUrl, reason: 'ERASURE_PURGE_PROBE_FAILED', userId, tenantId: doc.user.tenantId });
      }
      await prisma.$transaction(async (tx) => {
        await tx.verificationDocument.update({ where: { id: doc.id }, data: { purgedAt: new Date(), fileUrl: '' } });
        // [DOC-1 Part XXV] Erasure takes the extracted VALUES with the image: shred the run DEKs (rows stay as the custody record).
        await tx.extractionRun.updateMany({ where: { submissionId: doc.id }, data: { wrappedDek: null } });
        await tx.extractedField.updateMany({ where: { submissionId: doc.id }, data: { valueCt: null } });
        await writeDeletionReceipt(tx, { submissionId: doc.id, subjectId: userId, tenantId: doc.user.tenantId, docTypeCode: doc.docType, deletedBy: userId, evidence });
      });
    }

    // 1a. [F-024-08] The mandatory signup selfie lives in the avatar object,
    //     which is PUBLIC for the local provider. Nulling the column (step 4)
    //     leaves the object reachable — a DPA deletion-barrier breach. Delete
    //     the object here, before the column is cleared, so the census still
    //     knows the key. Absolute-URL / signed-URL legacy values aren't our
    //     keys to delete; bare keys and /uploads paths are. A failure is
    //     LOGGED (not silently swallowed) so an orphan is discoverable.
    // [F-026-02] Opportunistic retry of earlier orphans — account deletion is
    // a natural, already-privileged moment to work the census down without a
    // dedicated worker (IDV-1's sweeper takes standing ownership later).
    await retryStorageOrphans(prisma, storage, this.app.log).catch(() => undefined);

    const avatarRow = await prisma.user.findUnique({ where: { id: userId }, select: { avatar: true, tenantId: true } });
    const rawAvatar = avatarRow?.avatar;
    if (rawAvatar && !rawAvatar.startsWith('http://') && !rawAvatar.startsWith('https://')) {
      // Pass the stored value as-is: the provider's resolveKey normalises the
      // "/uploads/" prefix and refuses path escapes (same call the doc loop uses).
      await storage.delete(rawAvatar).catch(async (err) => {
        this.app.log.error({ err, userId, key: rawAvatar }, '[F-024-08] avatar object delete failed on account deletion — orphaned key');
        // [F-026-02] Nulling the column erases the only pointer — census it
        // durably so the deletion barrier survives this failure.
        await recordStorageOrphan(prisma, this.app.log, { key: rawAvatar, reason: 'ACCOUNT_DELETION_DELETE_FAILED', userId, tenantId: avatarRow?.tenantId });
      });
    }

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
      await prisma.identityKey.deleteMany({ where: { accountId: userId } });
      await prisma.identityClusterMember.deleteMany({ where: { accountId: userId } });
    }

    // 2. Revoke access everywhere: refresh sessions + push tokens.
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.deviceToken.deleteMany({ where: { userId } });

    // 3. Drop precise saved locations (home/work) outright.
    await prisma.address.deleteMany({ where: { userId } });

    // 3b. [NR-3 census gap 6] Ephemeral high-risk rows go WITH the account —
    //     recovery ID/selfie pointers, biometric liveness rows, public trip
    //     shares, third-party emergency contacts, exact-location queue/watch
    //     rows, and the cart. None has a continuing purpose once the person
    //     leaves; case-bound safety evidence lives elsewhere under its own
    //     hold rules.
    await prisma.accountRecovery.deleteMany({ where: { userId } });
    await prisma.livenessCheck.deleteMany({ where: { userId } });
    await prisma.tripShareToken.deleteMany({ where: { createdByUserId: userId } });
    await prisma.emergencyContact.deleteMany({ where: { userId } });
    await prisma.rideQueueEntry.deleteMany({ where: { customerId: userId } });
    await prisma.supplyWatch.deleteMany({ where: { customerId: userId } });
    await prisma.cart.deleteMany({ where: { customerId: userId } });

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
