import { Prisma, type VehicleType } from '@prisma/client';
import { CountryConfigService } from '../country/country-config.service';
import { isPassengerVehicle } from '../../config/vehicle-classes';
import { AppError } from '../../utils/errors';
import { approvedEvidenceFor, anyChecklistEvidenceFor, type EvidenceDb, type EvidenceRow } from './evidence';
import { BUCKET_OF, VEHICLE_INSURANCE_DOC_TYPE } from './doc-registry';
import { normalizeRegistrationMark, rootSubjectId } from './subjects';

export type DocumentMoverKind = 'RIDER' | 'DRIVER';
export interface MoverDocumentVerdict {
  allowed: boolean;
  reason: 'ok' | 'docs' | 'insurance';
  /** Earliest expiry of the chosen valid proofs; enforced again by the final SQL write. */
  validUntil: Date | null;
}
const denied = (reason: 'docs' | 'insurance'): MoverDocumentVerdict => ({ allowed: false, reason, validUntil: null });

async function currentVehicle(db: EvidenceDb, userId: string, countryCode: string, kind: DocumentMoverKind, lock = false) {
  const profile = kind === 'RIDER'
    ? await db.rider.findUnique({ where: { userId }, select: { licensePlate: true } })
    : await db.driver.findUnique({ where: { userId }, select: { licensePlate: true } });
  const mark = normalizeRegistrationMark(profile?.licensePlate ?? '');
  if (!mark) return { enforce: false, subjectId: null };
  const vehicle = lock
    ? (await db.$queryRaw<Array<{ subjectId: string }>>`
        SELECT "subjectId" FROM vehicle_profile WHERE "registrationMark" = ${mark} AND "countryCode" = ${countryCode}
        FOR SHARE /* mover-document-vehicle */`)[0]
    : await db.vehicleProfile.findUnique({
        where: { registrationMark_countryCode: { registrationMark: mark, countryCode } }, select: { subjectId: true },
      });
  if (!vehicle) return { enforce: true, subjectId: null };
  if (!lock) return { enforce: true, subjectId: await rootSubjectId(db, vehicle.subjectId) };
  let subjectId = vehicle.subjectId;
  for (let hops = 0; hops < 16; hops += 1) {
    const [subject] = await db.$queryRaw<Array<{ mergedIntoId: string | null }>>`
      SELECT "mergedIntoId" FROM subject WHERE id = ${subjectId}::uuid FOR SHARE /* mover-document-subject */`;
    if (!subject?.mergedIntoId) return { enforce: true, subjectId };
    subjectId = subject.mergedIntoId;
  }
  throw new AppError(409, 'VERIFICATION_REQUIRED', 'Vehicle document ownership needs review');

}

function expiry(row: EvidenceRow): number {
  return Math.min(row.expiresAt?.getTime() ?? Infinity, row.retentionExpiresAt?.getTime() ?? Infinity);
}

/** Preview or locked read: the caller chooses the operating profile explicitly. */
export async function evaluateMoverDocuments(
  db: EvidenceDb,
  userId: string,
  opts: { kind: DocumentMoverKind; vehicleType: VehicleType; legacyVerified?: boolean },
): Promise<MoverDocumentVerdict> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
  if (!user) return denied('docs');
  const required = await new CountryConfigService(db as never).getMoverChecklist(user.countryCode, opts.vehicleType, db);
  const hire = opts.kind === 'DRIVER' && isPassengerVehicle(opts.vehicleType);
  const types = [...new Set([...required, ...(hire ? [VEHICLE_INSURANCE_DOC_TYPE] : [])])];
  const vehicleTypes = types.filter((type) => BUCKET_OF[type] === 'VEHICLE');
  const target = vehicleTypes.length ? await currentVehicle(db, userId, user.countryCode, opts.kind) : null;
  const now = new Date();
  const rows = await approvedEvidenceFor(db, userId, types, now);
  const links = vehicleTypes.length ? await db.subjectLink.findMany({
    where: { accountId: userId, validTo: null, approvedAt: { not: null }, validFrom: { lte: now } },
    select: { subjectId: true },
  }) : [];
  const current: EvidenceRow[] = [];
  for (const row of rows) {
    if (!vehicleTypes.includes(row.docType)) {
      current.push(row);
    } else if (row.subjectId !== null) {
      if (row.subjectId === target?.subjectId && links.some((link) => link.subjectId === row.subjectId)) current.push(row);
    } else if (target?.subjectId == null) {
      current.push(row);
    } else {
      // Pre-subject valid evidence remains usable during a pending replacement.
      // Known terminal evidence about the current vehicle cannot be hidden by
      // filtering the subject's records to approved rows before this decision.
      const known = await db.verificationDocument.count({ where: {
        subjectId: target.subjectId, docType: row.docType, status: { not: 'PENDING' },
      } });
      if (known === 0) current.push(row);
    }
  }
  const missing = required.filter((type) => !current.some((row) => row.docType === type));
  if (missing.length && (!opts.legacyVerified || await anyChecklistEvidenceFor(db, userId, missing, target?.subjectId))) return denied('docs');
  const chosen = required.flatMap((type) => {
    const best = current.filter((row) => row.docType === type).sort((a, b) => expiry(b) - expiry(a))[0];
    return best ? [best] : [];
  });
  if (hire) {
    const insurance = current.filter((row) => row.docType === VEHICLE_INSURANCE_DOC_TYPE
      && row.coverageClass === 'HIRE' && row.hireClassConfirmed && row.plateCrossChecked)
      .sort((a, b) => expiry(b) - expiry(a))[0];
    if (!insurance) return denied('insurance');
    chosen.push(insurance);
  }
  const until = Math.min(...chosen.map(expiry));
  return { allowed: true, reason: 'ok', validUntil: Number.isFinite(until) ? new Date(until) : null };
}

/**
 * Caller holds this mover's User lock, then (for custody) Order. Lock profile,
 * assignment links, submissions and records in that order. A fleet uploader's
 * revoke/expiry must update the same submission before its record, so it cannot
 * commit between this fresh read and the operational write. No second User lock.
 */
export async function lockMoverDocuments(tx: Prisma.TransactionClient, userId: string, kind: DocumentMoverKind): Promise<MoverDocumentVerdict> {
  const profiles = kind === 'RIDER'
    ? await tx.$queryRaw<Array<{ vehicleType: VehicleType; documentsVerified: boolean }>>`
        SELECT "vehicleType", "documentsVerified" FROM riders WHERE "userId" = ${userId} FOR UPDATE`
    : await tx.$queryRaw<Array<{ vehicleType: VehicleType; documentsVerified: boolean }>>`
        SELECT "vehicleType", "documentsVerified" FROM drivers WHERE "userId" = ${userId} FOR UPDATE`;
  const profile = profiles[0];
  if (!profile) return denied('docs');
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { countryCode: true } });
  const target = await currentVehicle(tx, userId, user.countryCode, kind, true);
  await tx.$queryRaw`
    SELECT id FROM subject_link WHERE "accountId" = ${userId} ORDER BY id FOR SHARE /* mover-document-links */`;
  await tx.$queryRaw`
    SELECT d.id FROM verification_documents d
    WHERE d."userId" = ${userId} OR d."subjectId" = ${target.subjectId}::uuid OR d."subjectId" IN (
      SELECT "subjectId" FROM subject_link WHERE "accountId" = ${userId}
    ) ORDER BY d.id FOR SHARE /* mover-document-submissions */`;
  await tx.$queryRaw`
    SELECT r.id FROM document_record r
    WHERE r."accountId" = ${userId} OR r."subjectId" = ${target.subjectId}::uuid OR r."subjectId" IN (
      SELECT "subjectId" FROM subject_link WHERE "accountId" = ${userId}
    ) ORDER BY r.id FOR SHARE /* mover-document-records */`;
  return evaluateMoverDocuments(tx, userId, { kind, vehicleType: profile.vehicleType, legacyVerified: profile.documentsVerified });
}

export function assertMoverDocuments(verdict: MoverDocumentVerdict): void {
  if (!verdict.allowed) throw new AppError(403,
    verdict.reason === 'insurance' ? 'INSURANCE_HIRE_CLASS_REQUIRED' : 'VERIFICATION_REQUIRED',
    'Your required documents must be approved and current before taking work');
}

/** clock_timestamp is sampled at the actual write, after any PostgreSQL waits. */
export function documentDeadlineSql(verdict: MoverDocumentVerdict): Prisma.Sql {
  return verdict.validUntil === null ? Prisma.sql`TRUE` : Prisma.sql`${verdict.validUntil}::timestamptz > clock_timestamp()`;
}
export function expiredDocumentAuthority(): AppError {
  return new AppError(403, 'VERIFICATION_REQUIRED', 'A required document has expired. Renew it before taking work');
}
