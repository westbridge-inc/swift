import { Prisma, type PrismaClient, type UserRole } from '@prisma/client';
import { LEGAL_VERSION, TERMS, PRIVACY, DRIVER_AGREEMENT, VENDOR_AGREEMENT } from './legal.routes';
import { publishLegalDocumentOnce, recordConsent, type ConsentDocumentType, type ConsentSubjectType, type ConsentSurface } from './consent.service';
import { OPERATOR } from './operator';

/**
 * [Legal research G2 · R26 · owner 15 Oct 2026] A material change to the legal texts is not accepted by "continued
 * use": it is shown in short and accepted with a fresh tick at the next sign-in (website now, phone build 12).
 * Phone builds 9, 10 and 11 have no such screen and are never blocked by the server.
 *
 * MATERIAL_CHANGES lists every version that needs a fresh tick, newest last, with the short summary shown above the
 * tick. An entry only takes effect once that version is the served LEGAL_VERSION, so a summary can land before its
 * words do. A version not listed here (wording polish) needs no fresh tick.
 */
export const MATERIAL_CHANGES: ReadonlyArray<{ version: string; summary: readonly string[] }> = [
  {
    version: '2026-10-16',
    summary: [
      `The Terms and the Privacy Policy now name the company behind Swift — ${OPERATOR.name}, with its registration number, address and phone — and our data protection officer.`,
      'Swift never carries letters, documents or mail, and the Terms list everything Swift prohibits.',
      'Safety: Swift’s safety team is not an emergency service. In an emergency call Police 911, Fire 912 or Ambulance 913 first.',
      'Partners: Swift tells you in the app at least 14 days before a weekly-fee change, and refunds an unstarted week within 14 days when you close your account.',
      'Privacy: who processes your data and where our servers are, how a breach is handled, and that we answer a request within one month.',
    ],
  },
  {
    // [Owner rulings: identity checks by a person only, face matching off; customers take no photos (16 Oct)]
    version: '2026-10-17',
    summary: [
      'Identity checks are done by people on Swift’s verification team: no outside identity-verification provider and no automated face-matching receives your documents or selfie.',
      'Customers never need a photo, taxi rides included — a ride needs only your ID on file — and a mover or business is never shown a photo of a customer.',
      'Privacy: if a business takes MMG, the MMG payment details it gives Swift are shown to its customer on the order, so the customer pays the business directly.',
      'Privacy: a business or mover handling your order sees your first name and phone number, only to reach you about that order, never your last name.',
    ],
  },
  {
    // [Owner rulings 21 Oct 2026: taxi waiting charge ON at launch; phone crash reports ON · research E4 + B8]
    version: '2026-10-21',
    summary: [
      'Taxi: a waiting charge of GY$300 for each full 10 minutes the car waits for you, shown before you book. It counts from when your driver arrives at the pickup, never at your final destination; the app shows it as it runs and your receipt lists it separately.',
      'Privacy: if the Swift app crashes, it sends a crash report (phone model, app version and the error; never your messages or location) to Swift’s own server. Crash and error reports are kept for 90 days.',
    ],
  },
];

/**
 * Versions deliberately classed NOT material: no fresh tick, nobody is asked again. Each says why. Listing a version
 * here changes nothing at run time (a version absent from MATERIAL_CHANGES already needs no tick); it records the
 * decision, and `legal-reaccept.test.ts` requires every served LEGAL_VERSION to be classed exactly once.
 */
export const NON_MATERIAL_CHANGES: ReadonlyArray<{ version: string; why: string }> = [
  {
    // [COORD 18 Oct ruling: non-material; pre-launch] Privacy s.6 states what already happens to a customer's own ID.
    version: '2026-10-18',
    why: 'Privacy section 6 now says a customer\u2019s own ID is kept while the account is open and deleted with the account, which is what already happens; it takes nothing from anyone.',
  },
  {
    // [owner ruling 22 Oct 2026 23:05Z \u00b7 COORD 23:14Z: non-material PRE-LAUNCH; re-ruled MATERIAL if launch comes first]
    version: '2026-10-22',
    why: 'Terms section 7 shortens the free cancel window for a ride, a parcel or a booking from five minutes to one minute after a driver, rider or provider accepts it. It does take time from customers, but it lands before launch: no customer has used Swift under the five-minute window, so nobody is asked again.',
  },
  {
    // [ROLE-DOCS · owner 21 Oct 2026; COORD rulings 21 Oct (NON-material) + 23 Oct 00:59Z (stamped above 2026-10-22)]
    version: '2026-10-22.1',
    why: 'Swift asks for less: delivery riders are no longer offered a police clearance (only taxi drivers may add one), and the Privacy Policy and the driver agreement now say so. No one loses anything and no one is asked for more.',
  },
];

/** The newest material version that is already being served, or null. */
export function materialVersion(current: string = LEGAL_VERSION): string | null {
  const live = MATERIAL_CHANGES.filter((c) => c.version <= current);
  return live.length ? live[live.length - 1]!.version : null;
}

type Agreement = { documentType: ConsentDocumentType; subjectType: ConsentSubjectType; renderedText: string };

/** The partner agreements a person re-accepts with the Terms, by the roles they hold. */
function agreementsFor(roles: readonly UserRole[]): Agreement[] {
  const out: Agreement[] = [];
  // [REVIEW-F S3-1 on #1763] legacy RIDER / DRIVER accounts are movers too
  if (roles.some((r) => r === 'MOVER' || r === 'RIDER' || r === 'DRIVER')) out.push({ documentType: 'driver_agreement', subjectType: 'driver', renderedText: DRIVER_AGREEMENT });
  if (roles.includes('VENDOR_OWNER' as UserRole)) out.push({ documentType: 'vendor_agreement', subjectType: 'vendor_user', renderedText: VENDOR_AGREEMENT });
  return out;
}

export interface AcceptanceStatus {
  currentVersion: string;
  acceptedVersion: string | null;
  needsAcceptance: boolean;
  /** What changed, in short — empty when the person never accepted any version (they accept the current one). */
  summary: readonly string[];
  /** The partner agreements accepted with the Terms and Privacy Policy. */
  agreements: Array<'driver_agreement' | 'vendor_agreement'>;
}

export function acceptanceStatus(user: { tosVersion: string | null; roles: readonly UserRole[] }, current: string = LEGAL_VERSION): AcceptanceStatus {
  const material = materialVersion(current);
  const accepted = user.tosVersion;
  const needsAcceptance = accepted === null || (material !== null && accepted < material);
  // Every material change since the version this person accepted, oldest first — someone who skipped
  // 2026-10-16 and is asked at 2026-10-17 sees both summaries, never only the newest.
  const summary = accepted !== null
    ? MATERIAL_CHANGES.filter((c) => c.version > accepted && c.version <= current).flatMap((c) => c.summary)
    : [];
  return {
    currentVersion: current,
    acceptedVersion: accepted,
    needsAcceptance,
    summary,
    agreements: agreementsFor(user.roles).map((a) => a.documentType as 'driver_agreement' | 'vendor_agreement'),
  };
}

/**
 * Record the fresh tick: the Terms, the Privacy Policy and the person's partner agreements at the served version,
 * anchored to the exact words, in one transaction with the account's own stamp. Idempotent at the same version.
 */
export async function recordReacceptance(
  prisma: PrismaClient,
  input: { userId: string; roles: readonly UserRole[]; hadAccepted: boolean; surface: ConsentSurface; ip?: string | null },
): Promise<void> {
  const docs: Agreement[] = [
    { documentType: 'terms_of_service', subjectType: 'customer', renderedText: TERMS },
    { documentType: 'privacy_policy', subjectType: 'customer', renderedText: PRIVACY },
    ...agreementsFor(input.roles),
  ];
  for (const d of docs) {
    await publishLegalDocumentOnce(prisma, { documentType: d.documentType, version: LEGAL_VERSION, renderedText: d.renderedText });
  }
  await prisma.$transaction(async (tx) => {
    // One acceptance per person at a time; a double tap records once.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legal:reaccept:${input.userId}`}, 0))`);
    const now = await tx.user.findUnique({ where: { id: input.userId }, select: { tosVersion: true } });
    if (now?.tosVersion === LEGAL_VERSION) return;
    for (const d of docs) {
      await recordConsent(tx, {
        subjectType: d.subjectType,
        subjectId: input.userId,
        documentType: d.documentType,
        version: LEGAL_VERSION,
        action: input.hadAccepted ? 're_granted' : 'granted',
        surface: input.surface,
        ip: input.ip ?? null,
        evidence: { control: 'reaccept_checkbox', path: 'auth/legal-acceptance' },
      });
    }
    await tx.user.update({ where: { id: input.userId }, data: { tosVersion: LEGAL_VERSION, acceptedTermsAt: new Date() } });
  });
}
