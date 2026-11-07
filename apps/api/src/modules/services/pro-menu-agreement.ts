import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import type { ConsentDocumentType } from '../legal/consent.service';
import { compareLegalVersions } from '../legal/reaccept';
import { PRO_MENU_AGREEMENT } from './pro-menu-agreement-version';

// ---------------------------------------------------------------------------
// [BOOK-P3 · COORD ruling 29 Oct 2026 16:13Z] A PRO IS BOOKED FROM THEIR LIST
// OF SERVICES ONLY AFTER THEY AGREED TO IT.
//
// Terms s5 (2026-10-29) tells the customer that a pro who publishes a list of
// services with bookable times gives their acceptance in advance, so a booking
// the app shows as confirmed is a contract at that moment. The PROVIDER must
// have agreed to that too: their agreement (BILL-PRO's widened Business
// Agreement, owner B3) gains the advance-acceptance clause, and the server lets
// a pro be booked from their list (the list, the free times and the booking
// itself) only once the pro accepted a version of that agreement that carries
// the clause.
//
// FAIL-CLOSED until that version exists: `sinceVersion` (pro-menu-agreement-version.ts) is null, so NO pro is
// bookable from a list. BILL-PRO sets it (to the LEGAL_VERSION whose agreement
// text carries the clause) in the same PR that adds the clause: that one line is
// the switch. Work already booked is never gated (a move, a start, a completion,
// a cancel), the in-flight rule of provider-operate.ts.
// ---------------------------------------------------------------------------

// The one constant lives in its own module (pro-menu-agreement-version.ts) so it is the single
// line BILL-PRO changes.
export { PRO_MENU_AGREEMENT };

export const PRO_AGREEMENT_PENDING_CODE = 'PROVIDER_AGREEMENT_PENDING';
export const PRO_AGREEMENT_PENDING_MESSAGE = 'This provider isn’t taking bookings from their list of services yet. Ask them for a quote instead.';

type AgreementDb = Prisma.TransactionClient | PrismaClient;

/** Has this pro (by their user id) accepted, and not withdrawn, an agreement version that carries
 *  the advance-acceptance clause? The latest consent row for the document decides (any version
 *  older than `sinceVersion` is consent to words without the clause). */
export async function providerAcceptedMenuAgreement(
  db: AgreementDb,
  userId: string,
  agreement: { documentType: ConsentDocumentType; sinceVersion: string | null } = PRO_MENU_AGREEMENT,
): Promise<boolean> {
  if (agreement.sinceVersion == null) return false;
  const latest = await db.consentRecord.findFirst({
    where: { subjectId: userId, documentType: agreement.documentType },
    orderBy: { capturedAt: 'desc' },
    select: { action: true, documentVersion: true },
  });
  if (!latest || latest.action === 'withdrawn') return false;
  return compareLegalVersions(latest.documentVersion, agreement.sinceVersion) >= 0;
}

/** Refuses (409) unless this pro agreed to be booked from their list (see the header). */
export async function assertProviderMenuAgreement(db: AgreementDb, provider: { userId: string }): Promise<void> {
  if (!(await providerAcceptedMenuAgreement(db, provider.userId))) {
    throw new AppError(409, PRO_AGREEMENT_PENDING_CODE, PRO_AGREEMENT_PENDING_MESSAGE);
  }
}
