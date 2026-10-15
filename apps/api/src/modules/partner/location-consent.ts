import { Prisma, type PrismaClient } from '@prisma/client';
import {
  currentConsentDetailed,
  publishLegalDocumentOnce,
  recordConsent,
  type ConsentAction,
  type ConsentDocumentType,
  type ConsentSurface,
} from '../legal/consent.service';

/**
 * [R18 · research B1/B5 · DPA s.7(1)] Background location is the one mover
 * permission asked for separately (the Privacy Policy lists it under "with
 * your consent, separately asked and freely refusable"). The burden of proving
 * that consent is Swift's, so the phone's yes goes in the consent ledger,
 * anchored to the exact words of the in-app disclosure shown before the
 * system's permission sheet (mobile BackgroundLocationDisclosure).
 *
 * The disclosure has its own document version: the words change only when the
 * disclosure changes, never with a Terms or Privacy bump. The phone's copy is
 * pinned to LOCATION_BG_CONSENT_V1 by its own test; new words need 'v2'.
 */
export const LOCATION_BG_CONSENT_TYPE: ConsentDocumentType = 'location_bg_consent';
export const LOCATION_BG_CONSENT_VERSION = 'v1';
/** The disclosure, line by line as the phone shows it, then its two buttons. */
export const LOCATION_BG_CONSENT_V1 = 'Swift needs your location in the background\nWhile you are online, Swift collects your location even when the app is closed or not in use — so jobs can reach you, and so the customer can watch their delivery move.\nWhere you are, while you are online\nSent only to Swift and kept with our hosting provider, as the Privacy Policy explains — never sold, never shared with advertisers\nStops the moment you go offline\nYou can go online either way. Without background access Swift tracks you only while the app is on screen.\n[Allow background location] [Only while app is open]';

export type BackgroundConsentOutcome = { granted: boolean; changed: boolean };

/**
 * Record the mover's answer. One serialized transaction per person (advisory
 * lock): the latest ledger row decides, and an answer that changes nothing
 * writes nothing, so a phone repeating its yes never floods the ledger. A
 * withdrawal is a new row (the ledger is append-only).
 */
export async function recordBackgroundLocationConsent(
  prisma: PrismaClient,
  input: { userId: string; granted: boolean; surface: ConsentSurface; ip?: string | null },
): Promise<BackgroundConsentOutcome> {
  await publishLegalDocumentOnce(prisma, {
    documentType: LOCATION_BG_CONSENT_TYPE, version: LOCATION_BG_CONSENT_VERSION, renderedText: LOCATION_BG_CONSENT_V1,
  });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`consent:location_bg:${input.userId}`}, 0))`);
    const prior = await currentConsentDetailed(tx, 'driver', input.userId, LOCATION_BG_CONSENT_TYPE);
    const grantedNow = !!prior && (prior.action === 'granted' || prior.action === 're_granted');
    const grantedAtCurrent = grantedNow && prior.version === LOCATION_BG_CONSENT_VERSION;
    if (input.granted ? grantedAtCurrent : !grantedNow) return { granted: input.granted, changed: false };
    const action: ConsentAction = input.granted ? (prior ? 're_granted' : 'granted') : 'withdrawn';
    await recordConsent(tx, {
      subjectType: 'driver', subjectId: input.userId,
      documentType: LOCATION_BG_CONSENT_TYPE, version: LOCATION_BG_CONSENT_VERSION,
      action, surface: input.surface, ip: input.ip ?? null,
      evidence: input.granted
        ? { control: 'background_location_disclosure', button: 'Allow background location', osPermission: 'granted', path: 'partner/consent/background-location' }
        : { control: 'background_location_withdrawn', path: 'partner/consent/background-location' },
    });
    return { granted: input.granted, changed: true };
  });
}
