/**
 * [DOC-1 Part I · §9.1 · P1-1] Retention as a (country, document type, role) policy —
 * not one country-wide number.
 *
 * The registry row IS the policy row: `persistRetentionDays` is the clock for a persisted
 * image (BUSINESS / VEHICLE) counted from the relationship's end; the AML switch
 * (`amlRecordClass` other than NOT_APPLICABLE) extends the effective retention to
 * max(existing, 7 years) — computed here, never by a reviewer's judgement. A type with no
 * registry row, or a purge-after-review type whose image is already gone, falls back to
 * the country's default so no document is ever retained forever by omission.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { registryCode } from './doc-registry';

type Db = Prisma.TransactionClient | PrismaClient;

export const AML_RETENTION_DAYS = 7 * 365;

/**
 * [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID] A customer's ID picture is KEPT while the
 * account is open — so it is there if a safety incident, such as one on a taxi ride, needs it —
 * and deleted when the account closes (account deletion purges it with every other document;
 * the customer's own erasure request is honoured too). Nothing purges it early on a schedule:
 * this supersedes the "delete ID images within 30 days of the decision" rule (6 Oct) FOR
 * CUSTOMER IDs ONLY. Partner, driver and rider document retention is unchanged. Opening it is
 * for verification staff only; the document-reviewer grant on the open/decide doors enforces that.
 * DRAFT defaults like the rest of the table — the lawyer confirms before launch.
 */
export const CUSTOMER_ID_DOC_TYPE = 'identity_l2';
export function keptWhileAccountOpen(doc: { docType: string; role: string }): boolean {
  return doc.docType === CUSTOMER_ID_DOC_TYPE && doc.role === 'CUSTOMER';
}

export interface RetentionRuling {
  days: number;
  source: 'REGISTRY' | 'AML' | 'COUNTRY_DEFAULT';
  // Classification is separate from the winning duration: an AML class can
  // have a registry window longer than the seven-year floor.
  amlRecord: boolean;
  docType: string;
  role: string;
}

/** The days a submission of this type by this role is retained after the relationship ends. */
export async function retentionDaysFor(
  db: Db,
  input: { countryCode: string; docType: string; role: string; countryDefaultDays: number },
): Promise<RetentionRuling> {
  const row = await db.docType.findUnique({
    where: { code: registryCode(input.countryCode, input.docType) },
    select: { persistRetentionDays: true, amlRecordClass: true },
  });
  let days = input.countryDefaultDays;
  let source: RetentionRuling['source'] = 'COUNTRY_DEFAULT';
  if (row?.persistRetentionDays != null) { days = row.persistRetentionDays; source = 'REGISTRY'; }
  if (row && row.amlRecordClass !== 'NOT_APPLICABLE' && AML_RETENTION_DAYS > days) { days = AML_RETENTION_DAYS; source = 'AML'; }
  return { days, source, amlRecord: Boolean(row && row.amlRecordClass !== 'NOT_APPLICABLE'), docType: input.docType, role: input.role };
}
