import { Prisma, type PrismaClient } from '@prisma/client';
import {
  currentConsentDetailed, recordConsent, publishLegalDocumentOnce, type ConsentAction, type ConsentSurface,
} from './consent.service';
import { LEGAL_VERSION, MARKETING_CONSENT } from './legal.routes';

export type MarketingConsentOutcome = { marketing: boolean; changed: boolean };

/**
 * [DCR-1 NR1-03 · R22] Grant or withdraw marketing consent: the one place it changes.
 *
 * Both doors use it: the app's Account → Marketing messages switch and a texted STOP
 * (research B13, DPA s.17(2)-(3): a person may object to direct marketing, and it must
 * then stop). Withdrawal is a NEW ledger row (append-only) and takes effect at once. The
 * decision and the append happen in ONE serialized transaction (per-person advisory
 * lock), so a success is an authority boundary [REPORT-021 F-021-04]. Effectiveness is
 * version-aware: a grant to old words never suppresses re-consent to the current words
 * [F-021-02], and a withdrawal is written whenever any grant is still in force.
 */
export async function setMarketingConsent(
  prisma: PrismaClient,
  input: {
    userId: string;
    granted: boolean;
    surface: ConsentSurface;
    ip?: string | null;
    evidence: Record<string, unknown>;
  },
): Promise<MarketingConsentOutcome> {
  const { userId, granted } = input;
  await publishLegalDocumentOnce(prisma, {
    documentType: 'marketing_consent', version: LEGAL_VERSION, renderedText: MARKETING_CONSENT,
  });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`consent:marketing:${userId}`}, 0))`);
    const prior = await currentConsentDetailed(tx, 'customer', userId, 'marketing_consent');
    const effectiveAtCurrent = !!prior
      && (prior.action === 'granted' || prior.action === 're_granted')
      && prior.version === LEGAL_VERSION;
    const effectiveAtAny = !!prior && (prior.action === 'granted' || prior.action === 're_granted');
    if (granted === effectiveAtCurrent && (granted || !effectiveAtAny)) {
      return { marketing: effectiveAtCurrent, changed: false };
    }
    const action: ConsentAction = granted ? (prior ? 're_granted' : 'granted') : 'withdrawn';
    await recordConsent(tx, {
      subjectType: 'customer', subjectId: userId,
      documentType: 'marketing_consent', version: LEGAL_VERSION,
      action, surface: input.surface, ip: input.ip ?? null,
      evidence: input.evidence,
    });
    return { marketing: granted, changed: true };
  });
}
