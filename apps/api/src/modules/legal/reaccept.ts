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
      // [Owner ruling 24 Oct 2026] "a ride needs only your ID on file" is gone from this line: from 2026-10-25 a ride
      // needs no ID either, and this summary is still shown to anyone asked to re-accept from before 2026-10-17.
      'Customers never need a photo, taxi rides included, and a mover or business is never shown a photo of a customer.',
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
  {
    // [O-1 · owner rulings 22-24 Oct 2026 · COORD 25 Oct 15:20Z: MATERIAL — a new processor flow (Twilio, for calls)]
    version: '2026-10-25.1',
    summary: [
      'Privacy: when Swift’s call service is switched on, you call the other people on an order through Swift. Swift rings your phone from its own number and you press 1; then the person you call presses 1 to connect, and in the current app neither of you sees the other’s number. Twilio connects these calls.',
      'Privacy: calls through Swift are never recorded. For each call Swift keeps who asked for it (their account and their role on the order), the role they called, when, and whether it connected, never a phone number; the record of a call you asked for is deleted with your account.',
    ],
  },
  {
    // [EMAIL-HTTPS · owner 27 Oct 2026 · COORD 27 Oct: MATERIAL — a new processor flow (Resend, for email)]
    version: '2026-10-27',
    summary: [
      'Privacy: Swift’s emails (receipts, notices and the link to your data export) are now delivered by Resend, an email service. It receives your email address, if you gave one, and the email itself; it sends them from Brazil and keeps its records in the United States.',
    ],
  },
  {
    // [BOOK-FU2 · owner B3 28 Oct 2026 · COORD 19:06Z: MATERIAL — a new personal record ("Customer didn't come")]
    version: '2026-10-28.1',
    summary: [
      'Appointments: if a business records in the app that you did not come to an appointment you booked, the booking closes. That record carries no fee and no strike; a person at Swift reviews repeated missed appointments and may contact you about them.',
      'Privacy: Swift keeps that record (which booking it was, when the business recorded it, and who at the business recorded it) with the order’s record, for as long as the order’s record is kept.',
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
  {
    // [Owner ruling 24 Oct 2026 ~05:55Z — NO CUSTOMER ID GATE · non-material: it removes a requirement]
    version: '2026-10-25',
    why: 'Swift asks for less: taxi rides and larger orders no longer need a customer\u2019s ID on file. The Terms, the Privacy Policy and the Child Safety page now say so, and say when the app still asks for an ID (after repeated failed deliveries or payments, or for a high-value promotion). No one loses anything and no one is asked for more.',
  },
  {
    // [POLICE-CLEARANCE CONSENT · owner 25 Oct 2026 · COORD 25 Oct 22:17Z: NON-material]
    version: '2026-10-25.2',
    why: 'Privacy section 6 now says what Swift keeps of a police clearance (only whether it was clear and the date it was issued), that its image is deleted soon after the check, and that the person can withdraw it at any time in the app. It narrows what is kept and adds a right; it takes nothing from anyone and asks no one for more.',
  },
  {
    // [BOOK-S7 · owner rulings 28 Oct 2026 B1-B3 · PROVISIONAL: non-material PRE-LAUNCH, as 2026-10-22's cancel-window
    // edit; the owner rules on it. If ruled MATERIAL, move this version to MATERIAL_CHANGES with a summary instead.]
    version: '2026-10-28',
    why: 'Appointments booked from a business’s listing: while Swift’s instant appointment booking is switched on, a confirmed appointment cancels free until 2 hours before it starts (never less than one minute after it was confirmed) and the customer can move it until 2 hours before it starts; a booking the app shows as confirmed when it is made was accepted in advance by the business; businesses keep their availability current and honour bookings or cancel them with a reason. With the switch off nothing changes for anyone. It lands before launch, gives customers more time, and asks no one for more, so nobody is asked again.',
  },
  {
    // [TERMS · owner 29 Oct 2026 15:50Z: NON-material, like 2026-10-28 (owner 28 Oct 19:15Z); DRAFT until counsel]
    version: '2026-10-29',
    why: 'Terms section 7: an appointment booked from an individual service provider\u2019s list of services follows the same rules as one booked from a business\u2019s listing. While Swift\u2019s instant appointment booking is switched on, it cancels free until 2 hours before it starts (never less than one minute after it was confirmed) and the customer can move it until 2 hours before it starts; the provider can move it too, and the customer is told in the app; if the provider has not started it 30 minutes after its start time, it cancels free. Terms section 5: a booking from such a list that the app shows as confirmed when it is made was accepted in advance by the provider, who published the list. Before this, such a job could not be cancelled in the app once booked. It lands before launch, gives customers more, and asks no one for more, so nobody is asked again.',
  },
];

/**
 * [REVIEW-G S4 on #2001] How two legal versions order. A version is 'YYYY-MM-DD', or 'YYYY-MM-DD.N' for the
 * N-th later bump that day. Compared as plain strings, '2026-10-25.10' sorted before '2026-10-25.9', so a
 * tenth same-day bump could skip someone's fresh tick. The day compares as a date, the bump as a number (none
 * = 0). A stored version of any other shape counts as older than every real one, so that person is asked
 * again (the safe direction); two of them compare equal.
 */
const LEGAL_VERSION_SHAPE = /^(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d{0,3}))?$/;
export function compareLegalVersions(a: string, b: string): number {
  const x = LEGAL_VERSION_SHAPE.exec(a);
  const y = LEGAL_VERSION_SHAPE.exec(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  if (x[1] !== y[1]) return x[1]! < y[1]! ? -1 : 1;
  return Number(x[2] ?? 0) - Number(y[2] ?? 0);
}

type MaterialChange = { version: string; summary: readonly string[] };

/** The newest material version that is already being served, or null. */
export function materialVersion(current: string = LEGAL_VERSION, changes: ReadonlyArray<MaterialChange> = MATERIAL_CHANGES): string | null {
  const live = changes.filter((c) => compareLegalVersions(c.version, current) <= 0);
  return live.reduce<string | null>((newest, c) => (newest === null || compareLegalVersions(c.version, newest) > 0 ? c.version : newest), null);
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

export function acceptanceStatus(
  user: { tosVersion: string | null; roles: readonly UserRole[] },
  current: string = LEGAL_VERSION,
  changes: ReadonlyArray<MaterialChange> = MATERIAL_CHANGES,
): AcceptanceStatus {
  const material = materialVersion(current, changes);
  const accepted = user.tosVersion;
  const needsAcceptance = accepted === null || (material !== null && compareLegalVersions(accepted, material) < 0);
  // Every material change since the version this person accepted, oldest first — someone who skipped
  // 2026-10-16 and is asked at 2026-10-17 sees both summaries, never only the newest.
  const summary = accepted !== null
    ? changes.filter((c) => compareLegalVersions(c.version, accepted) > 0 && compareLegalVersions(c.version, current) <= 0)
      .sort((a, b) => compareLegalVersions(a.version, b.version)).flatMap((c) => c.summary)
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
