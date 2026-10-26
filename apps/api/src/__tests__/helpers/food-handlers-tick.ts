import type { PrismaClient } from '@prisma/client';
import { publishLegalDocumentOnce, recordConsent } from '../../modules/legal/consent.service';
import { FOOD_HANDLERS_CONSENT_TYPE, FOOD_HANDLERS_TICK_V1, FOOD_HANDLERS_VERSION } from '../../modules/vendor/food-handlers';

/**
 * [FOOD-PERMIT · owner ruling 24 Oct 2026] A registered restaurant goes live only on its owner's food handlers tick
 * (vendor/food-handlers.ts). A suite about some OTHER go-live rule gives the tick up front — the same ledger row the
 * route writes (POST /vendor/onboarding/food-handlers) — so that its own rule alone decides whether the store goes live.
 * Run it in a context that may write the consent ledger (runWithoutTenant / the system context).
 */
export async function giveFoodHandlersTick(prisma: PrismaClient, ownerUserId: string, vendorId: string): Promise<void> {
  await publishLegalDocumentOnce(prisma, { documentType: FOOD_HANDLERS_CONSENT_TYPE, version: FOOD_HANDLERS_VERSION, renderedText: FOOD_HANDLERS_TICK_V1 });
  await prisma.$transaction((tx) => recordConsent(tx, {
    subjectType: 'vendor_user', subjectId: ownerUserId, documentType: FOOD_HANDLERS_CONSENT_TYPE, version: FOOD_HANDLERS_VERSION,
    action: 'granted', surface: 'vendor_web', evidence: { vendorId, control: 'checkbox' },
  }));
}
