/**
 * [STORE-VAT · owner O-5] What a store says about its VAT, and what a PERSON decides about it.
 *
 * The store (its OWNER, never staff): "Is your business VAT-registered with the GRA?" No (default) = NONE, no VAT
 * anywhere. Yes = its VAT number (the existing profile field, format-checked by utils/vendor-vat-number.ts), how
 * its prices relate to VAT, and its GRA certificate of registration (VAT Act s.12(7)), sent through the existing
 * document intake. Saying yes makes the store PENDING; nothing a customer sees changes.
 *
 * A person (admin store-VAT decision): looks at the certificate, TYPES the VAT number printed on it (it must
 * match the number the store gave), the registered name and the effective date it states, and approves; or
 * rejects with a reason; or later revokes. Only that approval makes the store APPROVED (standing rule 4: never
 * shown as VAT-registered unless a person checked a current document). The certificate's own document decision
 * commits in the SAME transaction as the store's VAT decision (verification approveDocument/rejectDocument
 * `within`), so the two can never disagree.
 */
import type { Prisma, PrismaClient, VerificationDocument } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { vatNumberForWrite } from '../../utils/vendor-vat-number';
import { assertNotRecused } from '../verification/recusal';
import {
  STORE_VAT_MODES_OFFERED, STORE_VAT_SELECT, VAT_CERTIFICATE_DOC_TYPE, inEffectOn, storeVatEffective, storeVatEnabled,
} from './store-vat';
import { STORE_VAT_RATE_PERCENT, STORE_VAT_SOURCES } from './vat-rate';

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export const STORE_VAT_OFF_CODE = 'STORE_VAT_OFF';

function refuseWhileOff(env: Record<string, string | undefined>): void {
  if (!storeVatEnabled(env)) {
    throw new AppError(409, STORE_VAT_OFF_CODE, 'VAT settings are not available on Swift right now. Your prices stay exactly as you typed them.');
  }
}

/** The approval fields a new claim or a store's "no" clears (the decision trail lives in the audit log). */
const CLEARED_APPROVAL = {
  vatApprovedNumber: null, vatApprovedName: null, vatEffectiveFrom: null,
  vatReviewedBy: null, vatReviewedAt: null, vatReviewNote: null,
} as const;

/** Lock the store row: every VAT write on a store is serialised on it. */
async function lockVendor(tx: Tx, vendorId: string) {
  await tx.$queryRaw`SELECT "id" FROM "vendors" WHERE "id" = ${vendorId} FOR UPDATE /* store-vat-decision */`;
  const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: { ...STORE_VAT_SELECT, owner: { select: { userId: true } } } });
  if (!vendor) throw new NotFoundError('Vendor', vendorId);
  return vendor;
}

/** What the store's own settings screen (and the admin panel) shows. Never another store's. */
export async function storeVatView(db: Db, vendorId: string, env: Record<string, string | undefined> = process.env) {
  const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: STORE_VAT_SELECT });
  if (!vendor) throw new NotFoundError('Vendor', vendorId);
  const certificate = vendor.vatCertificateDocId
    ? await db.verificationDocument.findUnique({
      where: { id: vendor.vatCertificateDocId },
      select: { id: true, status: true, state: true, reviewNote: true, createdAt: true, reviewedAt: true },
    })
    : null;
  return {
    available: storeVatEnabled(env),
    status: vendor.vatStatus,
    mode: vendor.vatMode,
    vatRegistrationNumber: vendor.vatRegistrationNumber,
    /** True while this store's orders carry VAT (storeVatEffective). */
    effective: storeVatEffective(vendor, env),
    approved: vendor.vatStatus === 'APPROVED'
      ? { number: vendor.vatApprovedNumber, registeredName: vendor.vatApprovedName, effectiveFrom: vendor.vatEffectiveFrom, reviewedAt: vendor.vatReviewedAt }
      : null,
    reviewNote: vendor.vatStatus === 'REJECTED' || vendor.vatStatus === 'REVOKED' ? vendor.vatReviewNote : null,
    certificate,
    ratePercent: STORE_VAT_RATE_PERCENT,
    modesOffered: [...STORE_VAT_MODES_OFFERED],
    sources: STORE_VAT_SOURCES,
  };
}

export interface StoreVatSettingsInput {
  registered: boolean;
  vatRegistrationNumber?: string | null;
  mode?: string;
}

/**
 * The store's answer. "No" takes VAT off at once (NONE; the typed number is cleared too, so nothing can claim
 * VAT for it). "Yes" needs the number and a mode the server offers; a store that changes its number, or says
 * yes again after a rejection or revocation, goes back to PENDING (a person must look again). A mode change on
 * an APPROVED store keeps the approval: the person checked the registration, not the pricing choice.
 */
export async function updateStoreVatSettings(
  db: PrismaClient, vendorId: string, input: StoreVatSettingsInput, env: Record<string, string | undefined> = process.env,
) {
  if (!input.registered) {
    await db.$transaction(async (tx) => {
      await lockVendor(tx, vendorId);
      await tx.vendor.update({
        where: { id: vendorId },
        data: { vatStatus: 'NONE', vatMode: null, vatCertificateDocId: null, vatRegistrationNumber: null, ...CLEARED_APPROVAL },
      });
    });
    return storeVatView(db, vendorId, env);
  }
  refuseWhileOff(env);
  const number = input.vatRegistrationNumber === undefined ? undefined : vatNumberForWrite(input.vatRegistrationNumber);
  if (input.mode !== undefined && !STORE_VAT_MODES_OFFERED.has(input.mode)) {
    throw new AppError(409, 'VAT_MODE_NOT_AVAILABLE',
      input.mode === 'ADD_VAT_AT_CHECKOUT'
        ? 'Adding VAT at checkout is not available yet. Choose "My prices already include VAT" for now, or keep VAT off.'
        : 'Choose how your prices relate to VAT.');
  }
  await db.$transaction(async (tx) => {
    const vendor = await lockVendor(tx, vendorId);
    const nextNumber = number === undefined ? vendor.vatRegistrationNumber : number;
    const nextMode = input.mode ?? vendor.vatMode;
    if (!nextNumber) throw new AppError(400, 'VAT_NUMBER_REQUIRED', 'Type your VAT registration number exactly as it is on your GRA certificate.');
    if (!nextMode) throw new AppError(400, 'VAT_MODE_REQUIRED', 'Choose how your prices relate to VAT.');
    const keepsApproval = vendor.vatStatus === 'APPROVED' && nextNumber === vendor.vatApprovedNumber;
    const keepsPending = vendor.vatStatus === 'PENDING' && nextNumber === vendor.vatRegistrationNumber;
    await tx.vendor.update({
      where: { id: vendorId },
      data: {
        vatRegistrationNumber: nextNumber,
        vatMode: nextMode as 'PRICES_INCLUDE_VAT',
        ...(keepsApproval || keepsPending ? {} : { vatStatus: 'PENDING', ...CLEARED_APPROVAL }),
      },
    });
  });
  return storeVatView(db, vendorId, env);
}

/**
 * [called from the store profile save, inside its transaction] The store typed a different VAT number on its
 * profile. An approval (or a pending claim) for another number stops standing: PENDING again, so a person looks at
 * the new number; taking the number down entirely is a "no". The predicate already stops VAT on a mismatch; this
 * keeps the status honest. No-op for a store that never claimed VAT.
 */
export async function storeVatNumberChanged(tx: Tx, vendorId: string, number: string | null): Promise<void> {
  if (number === null) {
    await tx.vendor.updateMany({
      where: { id: vendorId, vatStatus: { in: ['PENDING', 'APPROVED'] } },
      data: { vatStatus: 'NONE', vatMode: null, vatCertificateDocId: null, ...CLEARED_APPROVAL },
    });
    return;
  }
  await tx.vendor.updateMany({
    where: { id: vendorId, vatStatus: 'APPROVED', NOT: { vatApprovedNumber: number } },
    data: { vatStatus: 'PENDING', ...CLEARED_APPROVAL },
  });
}

/** The certificate the store just sent becomes the one its VAT decision is about; the store is PENDING again
 *  (a new certificate is a new claim, looked at by a person). */
export async function linkVatCertificate(db: PrismaClient, vendorId: string, doc: Pick<VerificationDocument, 'id' | 'docType' | 'userId'>, env: Record<string, string | undefined> = process.env) {
  refuseWhileOff(env);
  if (doc.docType !== VAT_CERTIFICATE_DOC_TYPE) throw new AppError(400, 'INVALID_DOC_TYPE', 'That is not a VAT registration certificate.');
  await db.$transaction(async (tx) => {
    const vendor = await lockVendor(tx, vendorId);
    if (vendor.owner.userId !== doc.userId) throw new AppError(403, 'FORBIDDEN', 'Only the store owner can send its VAT certificate.');
    await tx.vendor.update({ where: { id: vendorId }, data: { vatCertificateDocId: doc.id, vatStatus: 'PENDING', ...CLEARED_APPROVAL } });
  });
  return storeVatView(db, vendorId, env);
}

/** What the reviewer types from the certificate. */
export interface StoreVatApprovalInput {
  certificateDocId: string;
  /** The VAT number printed on the certificate, typed by the reviewer. */
  typedVatNumber: string;
  /** The registered name printed on the certificate. */
  registeredName: string;
  /** The effective date printed on the certificate. */
  effectiveFrom: Date;
  /** The reviewer confirms the certificate's name is this store's business. */
  nameMatchesStore: true;
}

/** Minimal surface of VerificationService the decisions use (the admin route passes its instance). */
export interface DocumentDecider {
  approveDocument(docId: string, adminId: string, expiresAt?: Date, insurance?: undefined, typed?: Record<string, never>, decision?: { within?: (tx: Tx, decided: VerificationDocument) => Promise<void> }): Promise<VerificationDocument>;
  rejectDocument(docId: string, adminId: string, reason: string, reasonCode?: undefined, decision?: { within?: (tx: Tx, decided: VerificationDocument) => Promise<void> }): Promise<VerificationDocument>;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * A person approves a store's VAT. Refused unless: the switch is on; the store is PENDING about exactly this
 * certificate (the owner's own upload of the vat_registration_certificate type, not purged or revoked); the
 * reviewer is not recused from the owner; the typed number equals the store's number; a registered name is
 * given and confirmed to be the store's business; and the effective date is not in the future. A certificate
 * still PENDING is approved by the same person in the same transaction (the existing document review); one a
 * person already approved stands; one only a machine approved is never enough.
 */
export async function approveStoreVat(
  db: PrismaClient, verification: DocumentDecider, vendorId: string, adminId: string, input: StoreVatApprovalInput,
  audit: (tx: Tx, facts: Record<string, unknown>) => Promise<void>, env: Record<string, string | undefined> = process.env, now: Date = new Date(),
) {
  refuseWhileOff(env);
  if (input.nameMatchesStore !== true) throw new AppError(400, 'VAT_NAME_NOT_CONFIRMED', 'Confirm the registered name on the certificate is this store’s business.');
  const registeredName = input.registeredName.trim();
  if (registeredName.length < 2) throw new AppError(400, 'VAT_NAME_REQUIRED', 'Type the registered name exactly as the certificate shows it.');
  const typed = vatNumberForWrite(input.typedVatNumber);
  if (!typed) throw new AppError(400, 'VAT_NUMBER_REQUIRED', 'Type the VAT registration number printed on the certificate.');
  const effectiveFrom = startOfUtcDay(input.effectiveFrom);
  if (Number.isNaN(effectiveFrom.getTime())) throw new AppError(400, 'VAT_EFFECTIVE_DATE_REQUIRED', 'Type the effective date printed on the certificate.');
  // [REVIEW-M #2085 S4-1] "In the future" on the Guyana calendar, as the predicate reads it.
  if (!inEffectOn(effectiveFrom, now)) {
    throw new AppError(400, 'VAT_EFFECTIVE_IN_FUTURE', 'That certificate is not in effect yet. Approve it on or after its effective date.');
  }

  const apply = async (tx: Tx) => {
    const vendor = await lockVendor(tx, vendorId);
    if (vendor.vatStatus !== 'PENDING' || vendor.vatCertificateDocId !== input.certificateDocId) {
      throw new AppError(409, 'VAT_NOT_PENDING', 'This store is not waiting for a VAT decision on that certificate. Reload and look again.');
    }
    if (typed !== vendor.vatRegistrationNumber) {
      throw new AppError(409, 'VAT_NUMBER_MISMATCH', 'The number on the certificate is not the number the store gave. Reject it and tell the store, or ask the store to correct its number.');
    }
    await tx.vendor.update({
      where: { id: vendorId },
      data: {
        vatStatus: 'APPROVED', vatApprovedNumber: typed, vatApprovedName: registeredName, vatEffectiveFrom: effectiveFrom,
        vatReviewedBy: adminId, vatReviewedAt: now, vatReviewNote: null,
      },
    });
    await audit(tx, { vendorId, certificateDocId: input.certificateDocId, effectiveFrom: effectiveFrom.toISOString().slice(0, 10) });
  };

  const doc = await certificateFor(db, vendorId, input.certificateDocId);
  await assertNotRecused(db, adminId, doc.userId);
  if (doc.status === 'PENDING') {
    await verification.approveDocument(doc.id, adminId, undefined, undefined, {}, { within: async (tx) => apply(tx) });
  } else if (doc.status === 'APPROVED' && doc.state === 'COMMITTED' && doc.reviewedBy && !doc.reviewedBy.startsWith('kyc:')) {
    await db.$transaction(async (tx) => {
      // The person's approval must still stand at the moment this commits.
      const still = await tx.verificationDocument.findUnique({ where: { id: doc.id }, select: { status: true, state: true } });
      if (still?.status !== 'APPROVED' || still.state !== 'COMMITTED') throw new AppError(409, 'VAT_CERTIFICATE_NOT_STANDING', 'That certificate is no longer approved.');
      await apply(tx);
    });
  } else {
    throw new AppError(409, 'VAT_CERTIFICATE_NOT_STANDING', 'That certificate cannot back a VAT approval (rejected, withdrawn, or not checked by a person). Ask the store to send its certificate again.');
  }
  return storeVatView(db, vendorId, env);
}

async function certificateFor(db: Db, vendorId: string, docId: string) {
  const [vendor, doc] = await Promise.all([
    db.vendor.findUnique({ where: { id: vendorId }, select: { owner: { select: { userId: true } } } }),
    db.verificationDocument.findUnique({ where: { id: docId }, select: { id: true, userId: true, docType: true, status: true, state: true, reviewedBy: true } }),
  ]);
  if (!vendor) throw new NotFoundError('Vendor', vendorId);
  if (!doc || doc.docType !== VAT_CERTIFICATE_DOC_TYPE || doc.userId !== vendor.owner.userId) {
    throw new AppError(409, 'VAT_CERTIFICATE_NOT_STANDING', 'That document is not this store owner’s VAT certificate.');
  }
  return doc;
}

/** A person rejects the store's VAT claim (and its certificate, if still pending) with a reason the store sees. */
export async function rejectStoreVat(
  db: PrismaClient, verification: DocumentDecider, vendorId: string, adminId: string, reason: string,
  audit: (tx: Tx, facts: Record<string, unknown>) => Promise<void>, env: Record<string, string | undefined> = process.env, now: Date = new Date(),
) {
  const note = reason.trim();
  if (note.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Say why, in words the store will read.');
  const apply = async (tx: Tx) => {
    const vendor = await lockVendor(tx, vendorId);
    if (vendor.vatStatus !== 'PENDING') throw new AppError(409, 'VAT_NOT_PENDING', 'This store is not waiting for a VAT decision. Reload and look again.');
    await tx.vendor.update({ where: { id: vendorId }, data: { vatStatus: 'REJECTED', ...CLEARED_APPROVAL, vatReviewedBy: adminId, vatReviewedAt: now, vatReviewNote: note } });
    await audit(tx, { vendorId, certificateDocId: vendor.vatCertificateDocId });
  };
  const current = await db.vendor.findUnique({ where: { id: vendorId }, select: { vatCertificateDocId: true, owner: { select: { userId: true } } } });
  if (!current) throw new NotFoundError('Vendor', vendorId);
  await assertNotRecused(db, adminId, current.owner.userId);
  const doc = current.vatCertificateDocId
    ? await db.verificationDocument.findUnique({ where: { id: current.vatCertificateDocId }, select: { id: true, status: true } })
    : null;
  if (doc?.status === 'PENDING') {
    await verification.rejectDocument(doc.id, adminId, note, undefined, { within: async (tx) => apply(tx) });
  } else {
    await db.$transaction(async (tx) => apply(tx));
  }
  return storeVatView(db, vendorId, env);
}

/** A person withdraws an APPROVED store's VAT (e.g. GRA cancelled the registration, VAT Act s.13). New orders
 *  stop carrying VAT at once; orders already placed keep what they froze. */
export async function revokeStoreVat(
  db: PrismaClient | Tx, vendorId: string, adminId: string, reason: string,
  audit: (tx: Tx, facts: Record<string, unknown>) => Promise<void>, now: Date = new Date(),
) {
  const note = reason.trim();
  if (note.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Say why, in words the store will read.');
  const run = async (tx: Tx) => {
    const vendor = await lockVendor(tx, vendorId);
    if (vendor.vatStatus !== 'APPROVED') throw new AppError(409, 'VAT_NOT_APPROVED', 'This store’s VAT is not approved, so there is nothing to withdraw.');
    await tx.vendor.update({ where: { id: vendorId }, data: { vatStatus: 'REVOKED', vatReviewedBy: adminId, vatReviewedAt: now, vatReviewNote: note } });
    await audit(tx, { vendorId });
  };
  if ('$transaction' in db) await (db as PrismaClient).$transaction(async (tx) => run(tx));
  else await run(db);
}

/**
 * [called from VerificationService.revokeDocument, inside its transaction] A withdrawn VAT certificate withdraws
 * the VAT of every store whose approval rests on it. Never throws for a store that is not APPROVED.
 */
export async function revokeStoreVatForCertificate(tx: Tx, docId: string, adminId: string, reason: string, now: Date = new Date()): Promise<number> {
  const stores = await tx.vendor.findMany({ where: { vatCertificateDocId: docId, vatStatus: 'APPROVED' }, select: { id: true } });
  for (const store of stores) {
    await lockVendor(tx, store.id);
    await tx.vendor.updateMany({
      where: { id: store.id, vatStatus: 'APPROVED' },
      data: { vatStatus: 'REVOKED', vatReviewedBy: adminId, vatReviewedAt: now, vatReviewNote: `Certificate withdrawn: ${reason}` },
    });
  }
  return stores.length;
}

/** The admin queue: stores waiting for a VAT decision, oldest certificate first. */
export async function pendingStoreVat(db: Db, take = 50) {
  const stores = await db.vendor.findMany({
    where: { vatStatus: 'PENDING' },
    select: { ...STORE_VAT_SELECT, owner: { select: { userId: true } } },
    take,
  });
  const docIds = stores.map((s) => s.vatCertificateDocId).filter((id): id is string => !!id);
  const docs = docIds.length > 0
    ? await db.verificationDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, status: true, state: true, createdAt: true } })
    : [];
  const byId = new Map(docs.map((d) => [d.id, d]));
  return stores
    .map((s) => ({ vendorId: s.id, name: s.name, vatRegistrationNumber: s.vatRegistrationNumber, mode: s.vatMode, certificate: s.vatCertificateDocId ? byId.get(s.vatCertificateDocId) ?? null : null }))
    .sort((a, b) => (a.certificate?.createdAt?.getTime() ?? Infinity) - (b.certificate?.createdAt?.getTime() ?? Infinity));
}
