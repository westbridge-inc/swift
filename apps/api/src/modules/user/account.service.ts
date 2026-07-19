import type { FastifyInstance } from 'fastify';
import type { OrderStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { getStorageProvider } from '../../providers/storage/storage-provider';

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
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, roles: true, status: true } });
    if (!user) throw new AppError(404, 'NOT_FOUND', 'Account not found');
    if (user.status === 'DEACTIVATED') throw new AppError(409, 'ALREADY_CLOSED', 'This account is already closed');

    // Partner accounts (mover/vendor) close through Support — see note above.
    const partnerRoles = user.roles.filter((r) => r !== 'CUSTOMER');
    if (partnerRoles.length > 0) {
      throw new AppError(
        409,
        'PARTNER_ACCOUNT',
        'Mover and vendor accounts are closed through Support, so payouts and listings are handled correctly. Please contact support to proceed.',
      );
    }

    // Can't erase yourself mid-delivery.
    const inFlight = await prisma.order.count({ where: { customerId: userId, status: { notIn: TERMINAL_ORDER } } });
    if (inFlight > 0) {
      throw new AppError(409, 'ACTIVE_ORDERS', 'Finish or cancel your active orders before deleting your account.');
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

    // 2. Revoke access everywhere: refresh sessions + push tokens.
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.deviceToken.deleteMany({ where: { userId } });

    // 3. Drop precise saved locations (home/work) outright.
    await prisma.address.deleteMany({ where: { userId } });

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
