/**
 * [FOOD-PERMIT · owner ruling 24 Oct 2026] The restaurant food handler's certificate.
 *
 * A REGISTERED restaurant no longer uploads a food handler's certificate to go live: it MAY (RESTAURANT_OPTIONAL —
 * still uploadable, still reviewed by a person, still shown on its storefront while current). Instead its OWNER ticks,
 * for that store:
 *
 *   "Everyone who handles food here holds a current food handler's certificate."
 *
 * Why (Swift's research for counsel, B16/B19 and the service-trades checklist): the certificate belongs to each PERSON
 * who handles food — the Food Safety Act 2019 s.52 (once it operates) makes working as a food handler without a valid
 * permit an offence, and in Georgetown City by-law 70(3) makes employing someone in an eating-house without the
 * six-monthly examination one. A registered restaurant has staff Swift never sees, so one owner's certificate never
 * showed that; the business states it for all of them. Swift's own exposure is dispatching for a business it knows (or
 * failed to check) is unlicensed (B19), hence a required, recorded statement.
 *
 * A home cook selling on the self-declared tier IS the food handler: it keeps the certificate REQUIRED and never sees
 * this tick. Chefs and caterers (service trades) keep theirs.
 *
 * How it is kept: the consent ledger (append-only, the words hashed and versioned) — who ticked (the store's owner),
 * for which store (`evidence.vendorId`), when, and the words' version. A tick counts while the store's CURRENT owner's
 * latest row for that store is a grant of the CURRENT version: new words need a new tick. It is not a Terms or policy
 * text (no LEGAL_VERSION): like the own-name declaration and the weekly-fee tick, it is its own versioned document.
 *
 * The gate (verification.service projectVendorActivation; admin vendor-activation): a registered restaurant is never
 * MADE live without it — not on its first go-live, not coming back after its documents lapsed, not by the console.
 * A restaurant already live when this shipped is never taken down for it; it is told once to tick.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { ConsentDocumentType } from '../legal/consent.service';
import { FOOD_HANDLER_ATTESTATION_TYPE } from '../verification/doc-registry';

type Db = PrismaClient | Prisma.TransactionClient;

/** The ledger row carries the registry's one code (DOC-INV-2: no literal outside the registry). */
export const FOOD_HANDLERS_CONSENT_TYPE: ConsentDocumentType = FOOD_HANDLER_ATTESTATION_TYPE;
export const FOOD_HANDLERS_VERSION = 'v1';
/** The owner's words, exactly. A change is a new version — a version is a promise about specific words. */
export const FOOD_HANDLERS_TICK_V1 = 'Everyone who handles food here holds a current food handler’s certificate.';

/** The notice that asks the owner to tick (its tap opens the store's Documents, on Account). */
export const FOOD_HANDLERS_NOTICE_KIND = 'vendor_needs_food_handler_tick';

/** Who ticks: a registered restaurant. Never a home cook (self-declared tier), never another store type. */
export function foodHandlerTickApplies(store: { vendorType: string; tier: string | null }): boolean {
  return store.vendorType === 'RESTAURANT' && store.tier !== 'UNREGISTERED';
}

/** What the apps show: the words, their version, and (status) each store's state. */
export interface FoodHandlerStore { vendorId: string; name: string; attested: boolean }
export interface FoodHandlerAttestationView { version: string; tick: string; stores: FoodHandlerStore[] }

/**
 * Of these stores, the ones whose tick stands: the latest ledger row by `ownerUserId` (the store's current owner) for
 * that store is a grant (or re-grant) of the current version. A withdrawal, older words or a row by anyone else counts
 * for nothing.
 */
export async function attestedStoreIds(db: Db, ownerUserId: string, vendorIds: readonly string[]): Promise<Set<string>> {
  if (vendorIds.length === 0) return new Set();
  const rows = await db.consentRecord.findMany({
    where: { subjectType: 'vendor_user', subjectId: ownerUserId, documentType: FOOD_HANDLERS_CONSENT_TYPE },
    orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
    select: { action: true, documentVersion: true, evidence: true },
  });
  const wanted = new Set(vendorIds);
  const latest = new Map<string, { action: string; documentVersion: string }>();
  for (const row of rows) {
    const vendorId = (row.evidence as { vendorId?: unknown } | null)?.vendorId;
    if (typeof vendorId !== 'string' || !wanted.has(vendorId) || latest.has(vendorId)) continue;
    latest.set(vendorId, row);
  }
  const out = new Set<string>();
  for (const [vendorId, row] of latest) {
    if ((row.action === 'granted' || row.action === 're_granted') && row.documentVersion === FOOD_HANDLERS_VERSION) out.add(vendorId);
  }
  return out;
}

/** One store: has its owner's tick? */
export async function storeAttested(db: Db, ownerUserId: string, vendorId: string): Promise<boolean> {
  return (await attestedStoreIds(db, ownerUserId, [vendorId])).has(vendorId);
}

/** The owner's registered restaurants, each with its tick state (empty when the owner has none). */
export async function foodHandlerStoresOf(db: Db, ownerUserId: string): Promise<FoodHandlerStore[]> {
  const owner = await db.vendorOwner.findUnique({
    where: { userId: ownerUserId },
    select: { vendors: { select: { id: true, name: true, vendorType: true, tier: true }, orderBy: { createdAt: 'asc' } } },
  });
  const stores = (owner?.vendors ?? []).filter(foodHandlerTickApplies);
  const attested = await attestedStoreIds(db, ownerUserId, stores.map((s) => s.id));
  return stores.map((s) => ({ vendorId: s.id, name: s.name, attested: attested.has(s.id) }));
}

/** The words the apps show beside the stores. */
export function foodHandlerAttestationView(stores: FoodHandlerStore[]): FoodHandlerAttestationView {
  return { version: FOOD_HANDLERS_VERSION, tick: FOOD_HANDLERS_TICK_V1, stores };
}

/** Where to tick, for an app that cannot show it (phone builds before the tick shipped). */
export const FOOD_HANDLERS_WHERE = 'Don’t see it? Update the Swift app, or tick it in Settings on the Swift web dashboard.';

/** The one notice per store (and per reason): a store waiting to go live, or one already live. */
export function foodHandlersNotice(storeName: string, goingLive: boolean): { title: string; body: string } {
  return goingLive
    ? {
      title: 'Confirm your food handlers',
      body: `${storeName} has everything else it needs. Tick “${FOOD_HANDLERS_TICK_V1}” under Documents, and your store goes live. ${FOOD_HANDLERS_WHERE}`,
    }
    : {
      title: 'Confirm your food handlers',
      body: `Swift now asks every restaurant to confirm its food handlers. Tick “${FOOD_HANDLERS_TICK_V1}” for ${storeName} under Documents. ${FOOD_HANDLERS_WHERE}`,
    };
}
