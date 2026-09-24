/**
 * [DOC-1 §4.3 · P1-2] Subjects — the account is a join, not an owner.
 *
 * A document is evidence ABOUT a subject: a PERSON (one per account today), a
 * BUSINESS (one per owner account — ruling 2026-09-06), or a VEHICLE (one per
 * registration mark and country; every driver assigned to it is a link). The
 * resolver is the ONE place that decides which subject a submission belongs to,
 * from the registry's `subjectKind` for the document type (falling back to the
 * bucket), and it never invents a vehicle without a plate (DOC-INV-18: a bike
 * role inherits no VEHICLE subject). Merges are followed to the root.
 *
 * EXPAND beside `VerificationDocument.userId`: every NEW submission writes a
 * subject + link; legacy reads (isRoleVerified, the admin queue) are untouched;
 * `backfillSubjects` fills rows that predate this.
 */
import type { DocSubjectKind, Prisma, PrismaClient, SubjectRelation } from '@prisma/client';
import { BUCKET_OF, registryCode } from './doc-registry';

type Db = Prisma.TransactionClient | PrismaClient;

export const RELATION_OF_KIND: Record<DocSubjectKind, SubjectRelation> = {
  PERSON: 'SELF',
  BUSINESS: 'OWNER',
  VEHICLE: 'ASSIGNED_DRIVER',
};

/** Plates compare normalised: upper case, no spaces or dashes ("HB 1234" = "hb-1234"). */
export function normalizeRegistrationMark(mark: string): string {
  return mark.toUpperCase().replace(/[\s-]+/g, '');
}

/** The Guyana plate class is the first letter of the mark (H = hire). Computed, never stored twice. */
export function plateClassOf(mark: string): string {
  return normalizeRegistrationMark(mark).charAt(0);
}

/** The registry decides; a type the registry does not know falls back to its bucket. */
export async function subjectKindFor(db: Db, countryCode: string, docType: string): Promise<DocSubjectKind> {
  const row = await db.docType.findUnique({ where: { code: registryCode(countryCode, docType) }, select: { subjectKind: true } });
  if (row) return row.subjectKind;
  const bucket = BUCKET_OF[docType];
  return bucket === 'BUSINESS' ? 'BUSINESS' : bucket === 'VEHICLE' ? 'VEHICLE' : 'PERSON';
}

/** Follow identity-graph merges to the root subject. */
export async function rootSubjectId(db: Db, subjectId: string): Promise<string> {
  let id = subjectId;
  for (let hops = 0; hops < 16; hops++) {
    const s = await db.subject.findUnique({ where: { id }, select: { mergedIntoId: true } });
    if (!s?.mergedIntoId) return id;
    id = s.mergedIntoId;
  }
  return id;
}

/**
 * [High #9 · DS109] `approvedAt` carries the verdict that this account is a VERIFIED
 * operator/owner of the subject. A null stamp is a PENDING assignment: it names the
 * durable subject for a submission but never propagates the subject's evidence
 * (evidence.ts). Re-resolving with an approval promotes an existing pending link —
 * idempotent, and only ever null → set.
 */
async function ensureLink(db: Db, accountId: string, subjectId: string, relation: SubjectRelation, tenantId: string, approvedAt: Date | null) {
  const open = await db.subjectLink.findFirst({ where: { accountId, subjectId, relation, validTo: null }, select: { id: true, approvedAt: true } });
  if (open) {
    if (approvedAt && !open.approvedAt) {
      await db.subjectLink.updateMany({ where: { id: open.id }, data: { approvedAt } });
    }
    return open.id;
  }
  const created = await db.subjectLink.create({ data: { accountId, subjectId, relation, tenantId, approvedAt } });
  return created.id;
}

export interface ResolvedSubject {
  subjectId: string;
  kind: DocSubjectKind;
  relation: SubjectRelation;
  linkId: string;
  created: boolean;
  /** True when this account registered the subject (the verified owner of record). */
  owned: boolean;
}

/**
 * The subject a submission by `userId` of `docType` is evidence about — created on
 * first sight, reused after. Returns null only for a VEHICLE kind when the account
 * holds no registration mark (a bike, or a mover profile without a plate).
 */
export async function resolveSubject(
  db: Db,
  input: { userId: string; countryCode: string; docType: string; tenantId: string },
): Promise<ResolvedSubject | null> {
  const kind = await subjectKindFor(db, input.countryCode, input.docType);
  const relation = RELATION_OF_KIND[kind];
  if (kind === 'PERSON') {
    const existing = await db.personProfile.findUnique({ where: { accountId: input.userId }, select: { subjectId: true } });
    if (existing) {
      const subjectId = await rootSubjectId(db, existing.subjectId);
      return { subjectId, kind, relation, linkId: await ensureLink(db, input.userId, subjectId, relation, input.tenantId, null), created: false, owned: true };
    }
    const subject = await db.subject.create({ data: { kind, countryCode: input.countryCode, createdById: input.userId, tenantId: input.tenantId } });
    await db.personProfile.create({ data: { subjectId: subject.id, accountId: input.userId, tenantId: input.tenantId } });
    return { subjectId: subject.id, kind, relation, linkId: await ensureLink(db, input.userId, subject.id, relation, input.tenantId, null), created: true, owned: true };
  }
  if (kind === 'BUSINESS') {
    const existing = await db.businessProfile.findUnique({ where: { ownerAccountId: input.userId }, select: { subjectId: true } });
    if (existing) {
      const subjectId = await rootSubjectId(db, existing.subjectId);
      return { subjectId, kind, relation, linkId: await ensureLink(db, input.userId, subjectId, relation, input.tenantId, null), created: false, owned: true };
    }
    const owner = await db.vendorOwner.findUnique({ where: { userId: input.userId }, select: { vendors: { select: { name: true }, take: 1, orderBy: { createdAt: 'asc' } } } });
    const subject = await db.subject.create({ data: { kind, countryCode: input.countryCode, createdById: input.userId, tenantId: input.tenantId } });
    await db.businessProfile.create({ data: { subjectId: subject.id, ownerAccountId: input.userId, tenantId: input.tenantId, tradingName: owner?.vendors[0]?.name ?? null } });
    return { subjectId: subject.id, kind, relation, linkId: await ensureLink(db, input.userId, subject.id, relation, input.tenantId, null), created: true, owned: true };
  }
  // VEHICLE: the mover's registered plate names the vehicle; no plate, no vehicle subject.
  const driver = await db.driver.findUnique({ where: { userId: input.userId }, select: { licensePlate: true, vehicleType: true, vehicleMake: true, vehicleModel: true, vehicleYear: true, vehicleColor: true } });
  const rider = driver ? null : await db.rider.findUnique({ where: { userId: input.userId }, select: { licensePlate: true, vehicleType: true, vehicleMake: true, vehicleModel: true, vehicleYear: true, vehicleColor: true } });
  const profile = driver ?? rider;
  const rawMark = profile?.licensePlate?.trim();
  if (!profile || !rawMark) return null;
  const registrationMark = normalizeRegistrationMark(rawMark);
  const existing = await db.vehicleProfile.findUnique({
    where: { registrationMark_countryCode: { registrationMark, countryCode: input.countryCode } },
    select: { subjectId: true, subject: { select: { createdById: true } } },
  });
  if (existing) {
    const subjectId = await rootSubjectId(db, existing.subjectId);
    // [High #9 · DS109] Reusing a subject ANOTHER account registered is a PENDING
    // assignment: the submission names the durable vehicle, but its evidence does not
    // propagate to this account until an admin approves the link (approveVehicleAssignment).
    // The registering account is the verified owner of record and keeps an approved link.
    const owned = existing.subject.createdById === input.userId;
    return { subjectId, kind, relation, linkId: await ensureLink(db, input.userId, subjectId, relation, input.tenantId, owned ? new Date() : null), created: false, owned };
  }
  const subject = await db.subject.create({ data: { kind, countryCode: input.countryCode, createdById: input.userId, tenantId: input.tenantId } });
  await db.vehicleProfile.create({ data: {
    subjectId: subject.id, tenantId: input.tenantId, registrationMark, countryCode: input.countryCode, vehicleKind: profile.vehicleType,
    make: profile.vehicleMake ?? null, model: profile.vehicleModel ?? null, year: profile.vehicleYear ?? null, colour: profile.vehicleColor ?? null,
    registeredById: input.userId,
  } });
  return { subjectId: subject.id, kind, relation, linkId: await ensureLink(db, input.userId, subject.id, relation, input.tenantId, new Date()), created: true, owned: true };
}

/**
 * Every account with an OPEN, APPROVED link to a subject — the propagation set for a
 * vehicle lapse (§3.11, P3-4). [High #9 · DS109] A PENDING assignment propagates nothing,
 * so it is not in the set.
 */
export async function linkedAccountIds(db: Db, subjectId: string): Promise<string[]> {
  const root = await rootSubjectId(db, subjectId);
  const links = await db.subjectLink.findMany({ where: { subjectId: root, validTo: null, approvedAt: { not: null } }, select: { accountId: true } });
  return [...new Set(links.map((l) => l.accountId))];
}

/**
 * Fill `subjectId` on rows that predate subjects, in batches, idempotently. Returns
 * counts; a document whose account holds no plate stays unresolved and is counted.
 */
export async function backfillSubjects(prisma: PrismaClient, opts: { batch?: number; limit?: number } = {}): Promise<{ resolved: number; unresolved: number; scanned: number }> {
  const batch = opts.batch ?? 200; let resolved = 0, unresolved = 0, scanned = 0;
  const skip = new Set<string>();
  for (;;) {
    if (opts.limit !== undefined && scanned >= opts.limit) break;
    const rows = await prisma.verificationDocument.findMany({
      where: { subjectId: null, ...(skip.size ? { id: { notIn: [...skip] } } : {}) },
      select: { id: true, userId: true, docType: true, user: { select: { countryCode: true, tenantId: true } } },
      orderBy: { createdAt: 'asc' }, take: batch,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      scanned += 1;
      const done = await prisma.$transaction(async (tx) => {
        const s = await resolveSubject(tx, { userId: r.userId, countryCode: r.user.countryCode, docType: r.docType, tenantId: r.user.tenantId });
        if (!s) return false;
        await tx.verificationDocument.updateMany({ where: { id: r.id, subjectId: null }, data: { subjectId: s.subjectId } });
        return true;
      });
      if (done) resolved += 1; else { unresolved += 1; skip.add(r.id); }
    }
  }
  return { resolved, unresolved, scanned };
}
