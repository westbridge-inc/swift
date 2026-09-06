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

export interface RetentionRuling {
  days: number;
  source: 'REGISTRY' | 'AML' | 'COUNTRY_DEFAULT';
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
  return { days, source, docType: input.docType, role: input.role };
}
