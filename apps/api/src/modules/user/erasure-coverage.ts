/**
 * [GUARDRAILS §2 · REVIEW-F #1879 §4 · COORD 18 Oct 23:28Z + 19 Oct 03:46Z · owner 19 Oct (PRIVACY ASK A/A/A)]
 * The erasure passes that cover every person table the account erasure used to leave whole. Each is
 * idempotent: the standing re-sweep (account-erasure-retry) runs deleteAccount again for every tombstone, so a
 * row kept now because it is still owed, open or held is handled once it is done, closed or released.
 * account-erasure-register.ts names, for every table, what these passes do and why anything stays.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { bindTenantTransaction } from '../../plugins/prisma';
import { ACCOUNT_CLOSURE_MESSAGE, ACCOUNT_CLOSURE_SUBJECT, erasureExceptionOpen } from './account-closure';

/** What replaces a required text column the erasure empties. */
export const ERASED_TEXT = '[deleted with the account]';
/** What an erased card holds (the migration's payment_instruments erasure exception accepts exactly these). */
export const ERASED_CARD = {
  vaultTokenSealed: new Uint8Array(29), vaultTokenDek: new Uint8Array(33), brand: 'ERASED', last4: '0000', expMonth: 1, expYear: 2000,
} as const;
/** [REVIEW-G S4-2] What a support ticket's subject and message read after the erasure, so support sees why
 *  (owner G2: the text goes, even on an open ticket). "Account holder": partners' tickets get it too (COORD 21 Oct). */
export const TICKET_TEXT_REMOVED = "[text removed at the account holder's request]";
/** The checkout replay record keeps its order ids and date; this replaces its frozen response and request hash. */
export const ERASED_CHECKOUT_RESULT = { erased: true } as const;

async function lockPerson(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  await bindTenantTransaction(tx);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE /* erasure-coverage-authority */`;
  return rows.length === 1;
}

/**
 * Inside the erasure transaction (account.service revokeAccessBeforeCleanup: both branches, under the users
 * FOR UPDATE that every one of these rows' writers takes first or re-checks): work and notices owed to the
 * person go with the account.
 */
export async function eraseOwedRowsInTransaction(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await bindTenantTransaction(tx);
  await tx.notification.deleteMany({ where: { userId } });
  // [REVIEW-G S4-1 · COORD] Money-surface commands are an entity's audit chain (one generation per store or
  // partner, the writer takes max + 1). Only the person's OWN surface goes: their driver profile, closed with them.
  // A command they staged on a store or partner account that still exists stays where it is in that chain, with
  // the person replaced by the erased marker and its notice to them withdrawn, so no generation is ever reused.
  const ownDriver = await tx.driver.findUnique({ where: { userId }, select: { id: true } });
  if (ownDriver) await tx.moneySurfaceCommand.deleteMany({ where: { userId, actor: 'DRIVER', entityId: ownDriver.id } });
  await tx.moneySurfaceCommand.updateMany({
    where: { userId },
    data: { userId: `deleted:${userId}`, noticeKind: null, noticePayload: Prisma.DbNull, noticeDedupeKey: null },
  });
  // A row still unprocessed is owed to OTHER people (their orders re-dispatched, their notices): it stays until
  // its drain finishes, and the standing re-sweep deletes it then.
  await tx.moverRevocationOutbox.deleteMany({ where: { userId, processedAt: { not: null } } });
  // Safety check-in deliveries stay only while a safety deletion hold is open (read here, under the lock).
  const held = await tx.safetyDeletionHold.findFirst({ where: { userId, status: 'PENDING' }, select: { id: true } });
  if (!held) await tx.guardianCheckinDelivery.deleteMany({ where: { userId } });
  await tx.renewalSchedule.deleteMany({ where: { subjectId: userId } });
  await tx.admin.deleteMany({ where: { userId } });
}

/**
 * Every saved card leaves service (the removeInstrument path: REVOKED, its unsent charges closed, a charge
 * already handed off finishes and is reconciled). The row stays: the database keeps a card's binding, sealed
 * token and facts frozen and refuses its delete (PT-1, card_rail_v2); forgetting them is the follow-up
 * erasure exception. A card session that moved no money goes; one that is payment evidence stays.
 */
export async function retireCardsAndSessions(db: PrismaClient, userId: string): Promise<{ revoked: number; wiped: number; deleted: number; sessionsDeleted: number }> {
  const active = await db.paymentInstrument.findMany({ where: { userId, status: 'ACTIVE' }, select: { id: true, subscriptionId: true } });
  let revoked = 0;
  // Loaded only when there is a card to revoke (the billing modules are not part of every erasure).
  const { closeUnsentCardIntents } = active.length ? await import('../billing/billing.service') : { closeUnsentCardIntents: null };
  const { lockSubscriptionPayer } = active.length ? await import('../subscription/mover-fee-authority') : { lockSubscriptionPayer: null };
  for (const card of active) {
    revoked += await db.$transaction(async (tx) => {
      // payer -> subscription -> card: the order a charge's authorization and handoff take (card-rail.service).
      await lockSubscriptionPayer!(tx, card.subscriptionId);
      await tx.$queryRaw`SELECT "id" FROM "payment_instruments" WHERE "id" = ${card.id} FOR UPDATE`;
      const now = new Date();
      const out = await tx.paymentInstrument.updateMany({
        where: { id: card.id, userId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now, revokedBy: userId },
      });
      if (out.count !== 1) return 0;
      const unsent = await closeUnsentCardIntents!(tx, { instrumentId: card.id }, 'CARD_OUT_OF_SERVICE', now);
      await tx.auditLog.create({ data: {
        userId, action: 'CARD_REVOKED_ACCOUNT_DELETED', entity: 'PaymentInstrument', entityId: card.id,
        changes: { subscriptionId: card.subscriptionId, status: 'REVOKED', unsentChargesClosed: unsent },
      } });
      return 1;
    });
  }
  const forgotten = await db.$transaction(async (tx) => {
    if (!await lockPerson(tx, userId)) return { wiped: 0, deleted: 0 };
    // The database's gate, read under the person's lock: only an account the erasure has cut off.
    if (!await erasureExceptionOpen(tx, userId)) return { wiped: 0, deleted: 0 };
    // [erasure exception, payment_instruments_frozen] Out of service: token and wrapped key overwritten (the token is
    // unrecoverable), card facts replaced. The binding, consent and how it left service stay.
    const wiped = await tx.paymentInstrument.updateMany({
      where: { userId, status: { not: 'ACTIVE' }, brand: { not: ERASED_CARD.brand } },
      data: { ...ERASED_CARD },
    });
    // [payment_instruments_no_delete] An erased card that no payment, session, observation or replacement names goes.
    const unnamed = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT i."id" FROM "payment_instruments" i
      WHERE i."userId" = ${userId} AND i."status"::text <> 'ACTIVE' AND i."brand" = ${ERASED_CARD.brand}
        AND NOT EXISTS (SELECT 1 FROM "subscription_payments" p WHERE p."instrumentId" = i."id")
        AND NOT EXISTS (SELECT 1 FROM "card_sessions" s WHERE s."instrumentId" = i."id")
        AND NOT EXISTS (SELECT 1 FROM "card_observations" o WHERE o."instrumentId" = i."id")
        AND NOT EXISTS (SELECT 1 FROM "payment_instruments" r WHERE r."replacedById" = i."id")
      FOR UPDATE OF i /* erasure-card-forget */
    `;
    const deleted = unnamed.length ? (await tx.paymentInstrument.deleteMany({ where: { userId, id: { in: unnamed.map((r) => r.id) } } })).count : 0;
    return { wiped: wiped.count, deleted };
  });
  const sessionsDeleted = await db.$transaction(async (tx) => {
    if (!await lockPerson(tx, userId)) return 0;
    // Moved no money: terminal without success, no payment, provider transaction, card, provider action,
    // confirmation hold or observation naming it.
    const transient = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT s."id" FROM "card_sessions" s
      WHERE s."userId" = ${userId} AND s."status"::text IN ('FAILED', 'EXPIRED', 'CANCELLED')
        AND s."paymentId" IS NULL AND s."providerTransactionRef" IS NULL AND s."instrumentId" IS NULL
        AND s."providerVoidState" IS NULL AND s."providerRefundState" IS NULL
        AND s."bookClaimedAt" IS NULL AND s."completionClaimedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "payment_confirmation_holds" h WHERE h."cardSessionId" = s."id")
        AND NOT EXISTS (SELECT 1 FROM "card_observations" o WHERE o."sessionId" = s."id")
      FOR UPDATE OF s /* erasure-card-sessions */
    `;
    if (!transient.length) return 0;
    return (await tx.cardSession.deleteMany({ where: { userId, id: { in: transient.map((r) => r.id) } } })).count;
  });
  return { revoked, ...forgotten, sessionsDeleted };
}

/**
 * The profile rows stay (orders, rides, jobs and receipts point at them); what identifies the person goes.
 * Photos and documents go through the mover-object erasure and the unclaimed-upload erasure (#1818).
 */
export async function deidentifyProfiles(db: PrismaClient, userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    if (!await lockPerson(tx, userId)) return;
    await tx.rider.updateMany({ where: { userId }, data: {
      vehicleMake: null, vehicleModel: null, vehicleYear: null, vehicleColor: null, licensePlate: null,
      currentLat: null, currentLng: null, lastLocationUpdate: null, locationSessionId: null,
    } });
    // The driver's vehicle columns are required: emptied, not nulled. The year alone names no one.
    await tx.driver.updateMany({ where: { userId }, data: {
      vehicleMake: '', vehicleModel: '', vehicleColor: '', licensePlate: '', colorHex: null, bodyType: null,
      currentLat: null, currentLng: null, lastLocationUpdate: null, locationSessionId: null,
      mmgPayUrl: null, mmgPayUrlPending: null, mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null,
    } });
    await tx.serviceProvider.updateMany({ where: { userId }, data: { bio: null, portfolioPhotos: [] } });
    // Order totals stay. The referral link goes, and the code is retired so no one is referred to a closed account.
    const customer = await tx.customer.findUnique({ where: { userId }, select: { id: true, referralCode: true, referredBy: true } });
    if (customer && (!customer.referralCode.startsWith('retired-') || customer.referredBy !== null)) {
      await tx.customer.update({ where: { id: customer.id }, data: {
        referredBy: null, ...(customer.referralCode.startsWith('retired-') ? {} : { referralCode: `retired-${randomUUID()}` }),
      } });
    }
    await tx.checkoutReceipt.updateMany({
      where: { userId, NOT: { requestHash: ERASED_TEXT } },
      data: { result: ERASED_CHECKOUT_RESULT, requestHash: ERASED_TEXT },
    });
  });
}

/**
 * Owner 19 Oct (G1 + G2): fraud and abuse marks stay on the de-identified account without the phone, address
 * key or appeal text; case and request rows stay without their free text. A report the person filed keeps its
 * text while it is still being handled (the standing re-sweep clears it once resolved), and for good when it
 * was preserved for or sent to the authorities (a legal retention duty, Privacy Policy §6).
 */
export async function deidentifyCaseRecords(db: PrismaClient, userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    if (!await lockPerson(tx, userId)) return;
    // [erasure exception, safeb_payer_immutable] The payer hash and the digest that encodes it go; the row stays.
    if (await erasureExceptionOpen(tx, userId)) await tx.$executeRaw`
      UPDATE "mmg_payer_evidence" SET "payerHash" = 'erased', "digest" = 'erased:' || "id"
      WHERE "accountId" = ${userId} AND "payerHash" <> 'erased' /* erasure-payer-evidence */
    `;
    await tx.strike.updateMany({ where: { userId, OR: [{ phone: { not: null } }, { addressKey: { not: null } }] }, data: { phone: null, addressKey: null } });
    await tx.enforcementAction.updateMany({
      where: { accountId: userId, OR: [{ appealNote: { not: null } }, { NOT: { signalsFired: { equals: [] } } }] },
      data: { appealNote: null, signalsFired: [] },
    });
    // The closure request's subject and message are server-written (the support queue completes by them), and
    // so is its completion note: they stay. Every other ticket's text goes.
    await tx.supportTicket.updateMany({ where: { userId, subject: { notIn: [TICKET_TEXT_REMOVED, ACCOUNT_CLOSURE_SUBJECT] } }, data: { subject: TICKET_TEXT_REMOVED } });
    await tx.supportTicket.updateMany({ where: { userId, message: { notIn: [TICKET_TEXT_REMOVED, ACCOUNT_CLOSURE_MESSAGE] } }, data: { message: TICKET_TEXT_REMOVED } });
    await tx.supportTicket.updateMany({ where: { userId, adminNote: { not: null }, subject: { not: ACCOUNT_CLOSURE_SUBJECT } }, data: { adminNote: null } });
    await tx.complianceViolation.updateMany({ where: { userId, NOT: { evidence: { equals: {} } } }, data: { evidence: {} } });
    await tx.complianceReviewCase.updateMany({ where: { userId, note: { not: null } }, data: { note: null } });
    await tx.rectificationRequest.updateMany({ where: { userId, note: { not: ERASED_TEXT } }, data: { note: ERASED_TEXT } });
    await tx.contentReport.updateMany({
      where: {
        reporterId: userId, status: { in: ['ACTIONED', 'DISMISSED'] }, authorityRef: null,
        OR: [{ evidencePreserved: null }, { evidencePreserved: false }],
        AND: [{ OR: [{ detail: { not: null } }, { resolutionNote: { not: null } }] }],
      },
      data: { detail: null, resolutionNote: null },
    });
    await tx.ratingReport.updateMany({ where: { reporterId: userId, status: { not: 'PENDING' }, note: { not: null } }, data: { note: null } });
  });
}

/**
 * [REVIEW-M S3-1] The ONE keep-whole test for an incident case `c`: open, or any hold covers it (its legal-hold flag,
 * its legal_holds row, an unreleased document legal hold raised from it). Every keep-whole decision below (the case,
 * the SOS it covers, a trip session escalated into that SOS, and so the SOS bundle) uses it.
 */
export const CASE_KEPT_WHOLE = Prisma.sql`(c."status"::text <> 'CLOSED' OR c."legalHold"
  OR EXISTS (SELECT 1 FROM "legal_holds" l WHERE l."caseId" = c."id")
  OR EXISTS (SELECT 1 FROM "doc_legal_hold" d WHERE d."incidentCaseId" = c."id" AND d."releasedAt" IS NULL))`;

/**
 * Owner 19 Oct (G3): a safety record stays whole while its case is open or a hold covers it; otherwise its
 * location, address text and free text go (status, dates and the order link stay). Every hold is re-read here,
 * under the person's lock and the records' own row locks, so a hold placed before this commits is honoured
 * (legal-hold.ts sets the case/bundle flag under that row's lock) and a later one finds nothing left to defeat.
 */
export async function deidentifySafetyRecords(db: PrismaClient, userId: string): Promise<{ held: boolean }> {
  return db.$transaction(async (tx) => {
    if (!await lockPerson(tx, userId)) return { held: false };
    const [escrow, docHold] = await Promise.all([
      tx.safetyDeletionHold.findFirst({ where: { userId, status: 'PENDING' }, select: { id: true } }),
      tx.docLegalHold.findFirst({ where: { subjectUserId: userId, releasedAt: null }, select: { id: true } }),
    ]);
    if (escrow || docHold) return { held: true };

    // The incident cases about or by the person, closed and under no hold.
    const cases = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT c."id" FROM "IncidentCase" c
      WHERE (c."subjectUserId" = ${userId} OR c."reporterUserId" = ${userId})
      ORDER BY c."id" FOR UPDATE /* erasure-safety-cases */
    `;
    const closedCases = cases.length ? (await tx.$queryRaw<Array<{ id: string }>>`
      SELECT c."id" FROM "IncidentCase" c WHERE c."id" = ANY(${cases.map((c) => c.id)}::text[]) AND NOT ${CASE_KEPT_WHOLE}
    `).map((c) => c.id) : [];
    if (closedCases.length) {
      await tx.incidentCase.updateMany({ where: { id: { in: closedCases } }, data: { summary: ERASED_TEXT, details: Prisma.DbNull, decisionNotes: null } });
    }

    // The SOS alerts the person raised, closed, with no open or held case and no held bundle about them.
    const alerts = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT a."id" FROM "SosAlert" a
      WHERE a."actorUserId" = ${userId} AND a."status"::text IN ('RESOLVED', 'CANCELLED')
        AND NOT EXISTS (SELECT 1 FROM "IncidentCase" c WHERE c."sosAlertId" = a."id" AND ${CASE_KEPT_WHOLE})
        AND NOT EXISTS (SELECT 1 FROM "EvidenceBundle" b WHERE b."sosAlertId" = a."id" AND b."legalHold")
      ORDER BY a."id" FOR UPDATE OF a /* erasure-safety-sos */
    `;
    const alertIds = alerts.map((a) => a.id);
    if (alertIds.length) {
      await tx.sosAlert.updateMany({ where: { id: { in: alertIds } }, data: {
        triggerLat: null, triggerLng: null, triggerAccuracyM: null, triggerAddressText: null, triggerNote: null,
        resolutionNotes: null, retriggers: Prisma.DbNull,
      } });
      // Re-trigger rows are immutable facts (sos_retriggers_immutable): they go; the alert keeps the count and last time.
      await tx.sosRetrigger.deleteMany({ where: { sosAlertId: { in: alertIds } } });
    }

    // Trip safety sessions the person was in, closed, not escalated into an SOS that stays whole.
    const sessions = await tx.$queryRaw<Array<{ id: string; escalatedToSosId: string | null }>>`
      SELECT s."id", s."escalatedToSosId" FROM "TripSafetySession" s
      WHERE (s."passengerUserId" = ${userId} OR s."driverUserId" = ${userId}) AND s."status"::text = 'CLOSED'
      ORDER BY s."id" FOR UPDATE /* erasure-safety-sessions */
    `;
    const escalated = sessions.flatMap((s) => s.escalatedToSosId ? [s.escalatedToSosId] : []);
    const wholeSos = new Set(escalated.length ? (await tx.$queryRaw<Array<{ id: string }>>`
      SELECT a."id" FROM "SosAlert" a WHERE a."id" = ANY(${escalated}::text[]) AND (a."status"::text NOT IN ('RESOLVED', 'CANCELLED')
        OR EXISTS (SELECT 1 FROM "IncidentCase" c WHERE c."sosAlertId" = a."id" AND ${CASE_KEPT_WHOLE})
        OR EXISTS (SELECT 1 FROM "EvidenceBundle" b WHERE b."sosAlertId" = a."id" AND b."legalHold"))
    `).map((a) => a.id) : []);
    const sessionIds = sessions.filter((s) => !s.escalatedToSosId || !wholeSos.has(s.escalatedToSosId)).map((s) => s.id);
    if (sessionIds.length) {
      await tx.tripSafetySession.updateMany({ where: { id: { in: sessionIds } }, data: { riskFactors: Prisma.DbNull, deviationState: Prisma.DbNull } });
    }

    // Evidence bundles about the person: unheld, of a closed case or SOS. Their items go, sealed ones too (the
    // evidence_item_block_sealed erasure exception; COORD 19 Oct 04:51Z: the owner's G3 ruling outranks "sealed =
    // forever"). The bundle row, its seal hash and its dates stay as proof the evidence existed.
    const bundles = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT b."id" FROM "EvidenceBundle" b
      WHERE b."subjectUserId" = ${userId} AND NOT b."legalHold"
        AND (b."caseId" IS NULL OR b."caseId" = ANY(${closedCases}::text[]))
        AND (b."sosAlertId" IS NULL OR b."sosAlertId" = ANY(${alertIds}::text[]))
      ORDER BY b."id" FOR UPDATE /* erasure-safety-bundles */
    `;
    if (bundles.length) {
      const sealedToo = await erasureExceptionOpen(tx, userId);
      await tx.evidenceItem.deleteMany({ where: { bundleId: { in: bundles.map((b) => b.id) }, ...(sealedToo ? {} : { sealedAt: null }) } });
    }

    // Confirmed fraud cases about the person whose legal hold (if any) is released: the referral text and the
    // other accounts it linked go; the reason code, dates and case link stay.
    await tx.fraudCase.updateMany({
      where: { subjectUserId: userId, OR: [{ legalHoldId: null }, { legalHold: { releasedAt: { not: null } } }], NOT: { referral: ERASED_TEXT } },
      data: { referral: ERASED_TEXT, linkedAccountIds: [] },
    });

    // Parcel recovery cases the person held or relayed as a rider, resolved: location and note go.
    const rider = await tx.rider.findUnique({ where: { userId }, select: { id: true } });
    if (rider) {
      await tx.custodyRecoveryCase.updateMany({
        where: {
          OR: [{ holderRiderId: rider.id }, { relayRiderId: rider.id }], resolvedAt: { not: null },
          AND: [{ OR: [{ incidentLat: { not: null } }, { incidentLng: { not: null } }, { reasonNote: { not: null } }] }],
        },
        // A resolved case carries no transfer code (custody_recovery_cases_transfer_code_check).
        data: { incidentLat: null, incidentLng: null, reasonNote: null },
      });
    }
    return { held: false };
  });
}
