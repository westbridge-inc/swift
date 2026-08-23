import { recordStorageOrphan, retryStorageOrphans } from '../../lib/storage-orphans';
import type { FastifyInstance } from 'fastify';
import type { OrderStatus, ServiceJobStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { disconnectUserSockets } from '../../utils/socket-revocation';

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
// Scope: a pure CUSTOMER account. Mover/vendor accounts carry payouts, live
// listings and staff, so they close through Support where those are wound down
// correctly — a self-delete would orphan a running catalogue.
// ---------------------------------------------------------------------------

// A closed order is safe to leave behind; anything else is in-flight and must
// finish (or be cancelled) before the customer can erase themselves.
const TERMINAL_ORDER: OrderStatus[] = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
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
        return { alreadyComplete: false, resweep: true };
      }
      if (user.status !== 'ACTIVE' && user.status !== 'DEACTIVATED') {
        throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active and must be closed through Support.');
      }

      // Partner accounts (mover/vendor) close through Support — see note above.
      const partnerRoles = user.roles.filter((role) => role !== 'CUSTOMER');
      if (partnerRoles.length > 0) {
        throw new AppError(
          409,
          'PARTNER_ACCOUNT',
          'Mover and vendor accounts are closed through Support, so payouts and listings are handled correctly. Please contact support to proceed.',
        );
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

      // Cut public/action authority before any fallible retention work. The
      // relational ACTIVE check is authoritative; the profile flag is a second
      // fail-closed barrier for old clients and background consumers.
      await tx.serviceProvider.updateMany({ where: { userId }, data: { isVerified: false } });
      await tx.user.update({ where: { id: userId }, data: { status: 'DEACTIVATED' } });
      return { alreadyComplete: false };
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

    // 1. Crypto-shred every verification document: delete the object, null the
    //    wrapped DEK (unrecoverable even from a ciphertext backup), mark purged.
    const storage = getStorageProvider();
    const docs = await prisma.verificationDocument.findMany({
      where: { userId, purgedAt: null },
      select: { id: true, fileUrl: true },
    });
    for (const doc of docs) {
      if (doc.fileUrl) {
        await storage.delete(doc.fileUrl).catch(() => {});
        await prisma.encryptedObject.updateMany({
          where: { fileKey: doc.fileUrl },
          data: { wrappedDek: null, shreddedAt: new Date() },
        });
      }
      await prisma.verificationDocument.update({ where: { id: doc.id }, data: { purgedAt: new Date(), fileUrl: '' } });
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

    return { deleted: true };
  }
}
