import type { QualificationType } from '@prisma/client';
import type { ServiceCatalog, ServiceCategory } from '@swift/types';
import { AppError } from '../../utils/errors';
import { DEFAULT_DOCUMENT_CHECKLISTS, SERVICE_TRADE_LAUNCH_FLOOR } from '../ops/platform-config';
import { SERVICE_DOCUMENT_WORDS } from '../verification/doc-registry';

// ---------------------------------------------------------------------------
// Services vertical (spec §4.6). Trust is risk-tiered: verify hard where someone
// could be physically harmed. Every provider needs ID + police clearance; a
// trade qualification is an optional "Certified" badge. Providers without one
// can still join, shown transparently as "self-skilled". A trade the law
// licenses also needs that licence before it goes live (SERVICE_TRADE_LAUNCH_FLOOR).
// ---------------------------------------------------------------------------

export const SERVICE_TRADE_CATALOG = {
  electrician: {
    label: 'Electrician', riskTier: 'HIGH',
    aliases: ['electrician', 'electrical', 'electrical contractor', 'electrical installation contractor'],
  },
  plumber: {
    label: 'Plumber', riskTier: 'HIGH',
    aliases: ['plumber', 'plumbing', 'major plumbing'],
  },
  gas_fitter: {
    label: 'Gas fitter', riskTier: 'HIGH',
    aliases: ['gas fitter', 'gas fitting', 'gas technician'],
  },
  carpenter: {
    label: 'Carpenter / joiner', riskTier: 'LOW',
    aliases: ['carpenter', 'carpentry', 'joiner', 'carpenter joiner'],
  },
  cleaner: { label: 'Cleaner', riskTier: 'LOW', aliases: ['cleaner', 'cleaning', 'house cleaner'] },
  ac_refrigeration: {
    label: 'AC & refrigeration technician', riskTier: 'LOW',
    aliases: ['ac repair', 'a c repair', 'ac refrigeration', 'ac and refrigeration technician', 'air conditioning repair', 'refrigeration technician', 'hvac'],
  },
  mechanic: { label: 'Mechanic', riskTier: 'LOW', aliases: ['mechanic', 'auto mechanic', 'vehicle mechanic'] },
  painter: { label: 'Painter', riskTier: 'LOW', aliases: ['painter', 'painting', 'house painter'] },
  mason: { label: 'Mason', riskTier: 'LOW', aliases: ['mason', 'masonry', 'bricklayer'] },
  welder: {
    label: 'Welder / fabricator', riskTier: 'LOW',
    aliases: ['welder', 'welding', 'fabricator', 'welder fabricator'],
  },
  gardener: { label: 'Gardener', riskTier: 'LOW', aliases: ['gardener', 'gardening', 'landscaper', 'landscaping'] },
  appliance_electronics_repair: {
    label: 'Appliance & electronics repair', riskTier: 'LOW',
    aliases: ['appliance repair', 'electronics repair', 'appliance and electronics repair'],
  },
  solar_generator_inverter_installer: {
    label: 'Solar / generator / inverter installer', riskTier: 'LOW',
    aliases: ['solar installer', 'generator installer', 'inverter installer', 'solar generator inverter installer'],
  },
  tiler: { label: 'Tiler', riskTier: 'LOW', aliases: ['tiler', 'tiling', 'tile installer'] },
  pest_control: { label: 'Pest control', riskTier: 'LOW', aliases: ['pest control', 'exterminator'] },
  heavy_equipment_operator: {
    label: 'Heavy-equipment operator', riskTier: 'LOW',
    aliases: ['heavy equipment operator', 'heavy machinery operator'],
  },
  chef: { label: 'Chef', riskTier: 'LOW', aliases: ['chef', 'personal chef'] },
  caterer: { label: 'Caterer', riskTier: 'LOW', aliases: ['caterer', 'catering'] },
  party_organizer: { label: 'Party organizer', riskTier: 'LOW', aliases: ['party organizer', 'event planner', 'party planner'] },
  barber: { label: 'Barber', riskTier: 'LOW', aliases: ['barber', 'barbering'] },
  hairdresser: { label: 'Hairdresser', riskTier: 'LOW', aliases: ['hairdresser', 'hair stylist', 'hairstylist'] },
  tutor: { label: 'Tutor', riskTier: 'LOW', aliases: ['tutor', 'tutoring'] },
  salon: { label: 'Beauty salon', riskTier: 'LOW', aliases: ['salon', 'beauty salon', 'beautician'] },
  nail_technician: { label: 'Nail technician', riskTier: 'LOW', aliases: ['nail technician', 'manicure', 'pedicure'] },
  makeup_artist: { label: 'Makeup artist', riskTier: 'LOW', aliases: ['makeup artist', 'make up artist'] },
  photographer: { label: 'Photographer', riskTier: 'LOW', aliases: ['photographer', 'photography'] },
  lawyer: { label: 'Lawyer', riskTier: 'HIGH', aliases: ['lawyer', 'attorney', 'attorney at law', 'legal consultation'] },
  accountant: { label: 'Accountant', riskTier: 'HIGH', aliases: ['accountant', 'accounting', 'tax consultation'] },
  mover: { label: 'Mover', riskTier: 'LOW', aliases: ['mover', 'moving service', 'furniture mover'] },
} as const;

export type ServiceTradeId = keyof typeof SERVICE_TRADE_CATALOG;

function normalizeTradeAlias(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const SERVICE_TRADE_ALIASES = new Map<string, ServiceTradeId>();
for (const [tradeId, entry] of Object.entries(SERVICE_TRADE_CATALOG) as Array<[
  ServiceTradeId,
  (typeof SERVICE_TRADE_CATALOG)[ServiceTradeId],
]>) {
  SERVICE_TRADE_ALIASES.set(normalizeTradeAlias(tradeId), tradeId);
  for (const alias of entry.aliases) SERVICE_TRADE_ALIASES.set(normalizeTradeAlias(alias), tradeId);
}

/** Translate user-facing labels/legacy aliases to the one persisted trade ID. */
export function canonicalServiceTrade(input: string): ServiceTradeId | null {
  return SERVICE_TRADE_ALIASES.get(normalizeTradeAlias(input)) ?? null;
}

export function requireCanonicalServiceTrade(input: string): ServiceTradeId {
  const trade = canonicalServiceTrade(input);
  if (!trade) {
    throw new AppError(400, 'UNKNOWN_SERVICE_TRADE', 'Choose a service from Swift’s supported trade catalog.');
  }
  if (!isServiceCategoryOperational(trade)) {
    throw new AppError(409, 'SERVICE_CATEGORY_UNAVAILABLE', 'This service is not accepting profiles or requests yet. Its required checks are still being prepared.');
  }
  return trade;
}

// A category with an unresolved policy topic must never inherit the generic
// base checklist and become live with identity documents alone. Opening one
// requires a reviewed country checklist and an enforceable evidence path.
// [TRADES · owner 13 Oct 2026, decisions 23 + 40] Thirteen trades opened with
// their reviewed checklists (ops/platform-config SERVICE_TRADE_LAUNCH_FLOOR).
// The lawyer stays held until counsel confirms it: lawyers may not advertise
// their services, and a platform paid by a lawyer for bringing them clients may
// itself commit an offence.
const PENDING_CATEGORIES = new Set<ServiceTradeId>(['lawyer']);

export function isServiceCategoryOperational(trade: ServiceTradeId): boolean {
  return !PENDING_CATEGORIES.has(trade);
}

const PERSONAL_CARE = new Set<ServiceTradeId>(['barber', 'hairdresser', 'salon', 'nail_technician', 'makeup_artist']);
const EVENTS = new Set<ServiceTradeId>(['chef', 'caterer', 'party_organizer', 'photographer']);

function categoryGroup(trade: ServiceTradeId): ServiceCategory['group'] {
  if (PERSONAL_CARE.has(trade)) return 'PERSONAL_CARE';
  if (EVENTS.has(trade)) return 'EVENTS';
  if (trade === 'tutor') return 'EDUCATION';
  if (trade === 'lawyer' || trade === 'accountant') return 'PROFESSIONAL';
  return 'HOME_AND_TRADES';
}

/** [TRADES] What a trade must also know before signing up, in plain words. */
const TRADE_NOTES: Partial<Record<ServiceTradeId, readonly string[]>> = {
  gas_fitter: ['Installation and repair only: selling, refilling or delivering cooking gas (LPG) is not allowed on Swift.'],
  tutor: ['The police clearance is always required: tutors work with children.'],
  photographer: ['Drone or aerial work: add the GCAA authorisation before you offer it.'],
};

function categoryDocuments(trade: ServiceTradeId): ServiceCategory['documents'] {
  const floor = SERVICE_TRADE_LAUNCH_FLOOR[trade];
  if (floor) {
    // [TRADES] An opened trade lists exactly what it must show, then what it may add.
    const optional = DEFAULT_DOCUMENT_CHECKLISTS[`SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}_OPTIONAL`] ?? [];
    return [
      ...floor.map((docType) => ({ key: `DOC_${docType.toUpperCase()}`, label: SERVICE_DOCUMENT_WORDS[docType] ?? docType, status: 'COUNTRY_CHECKLIST' as const })),
      ...optional.map((docType) => ({ key: `OPTIONAL_${docType.toUpperCase()}`, label: `If it applies to you: ${SERVICE_DOCUMENT_WORDS[docType] ?? docType}`, status: 'COUNTRY_CHECKLIST' as const })),
      ...(TRADE_NOTES[trade] ?? []).map((label, i) => ({ key: `NOTE_${trade.toUpperCase()}_${i + 1}`, label, status: 'COUNTRY_CHECKLIST' as const })),
    ];
  }
  const documents: ServiceCategory['documents'] = [{
    key: 'SERVICE_PROVIDER',
    label: 'Identity and any background checks required by your country checklist',
    status: 'COUNTRY_CHECKLIST',
  }, {
    key: `SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}`,
    label: 'Additional checks for this service, where configured',
    status: 'COUNTRY_CHECKLIST',
  }];
  // These are review topics, not invented legal requirements or upload gates.
  // The live verification checklist remains the authority for actual uploads.
  const pending: Partial<Record<ServiceTradeId, string>> = {
    lawyer: 'Right to practise and current professional standing',
  };
  if (pending[trade]) documents.push({
    key: `POLICY_${trade.toUpperCase()}`, label: pending[trade]!, status: 'POLICY_REVIEW_REQUIRED',
  });
  return documents;
}

/** This endpoint exposes intent and availability separately. It cannot enable
 * appointment checkout: slot/timezone/lifecycle repairs are still required. */
export function publicServiceCatalog(): ServiceCatalog {
  return {
    version: 1,
    documentNotice: 'Requirements depend on your country and service. Your verification checklist shows the documents to upload. Review topics are not proof of approval or a request to upload extra documents.',
    categories: (Object.entries(SERVICE_TRADE_CATALOG) as Array<[ServiceTradeId, (typeof SERVICE_TRADE_CATALOG)[ServiceTradeId]]>)
      .map(([id, entry]) => ({
        id, label: entry.label, group: categoryGroup(id), riskTier: entry.riskTier,
        modes: ['QUOTE_JOB'],
        quoteRequestsEnabled: isServiceCategoryOperational(id),
        appointmentsEnabled: false,
        availabilityMessage: !isServiceCategoryOperational(id)
          ? 'Not available yet — service-specific checks are being prepared.'
          : PERSONAL_CARE.has(id) || id === 'tutor'
            ? 'Request a quote and agree a time with your provider. Instant appointment booking is not available yet.'
            : null,
        documents: categoryDocuments(id),
      })),
  };
}

export function serviceTradeLabel(trade: string): string {
  const canonical = canonicalServiceTrade(trade);
  return canonical ? SERVICE_TRADE_CATALOG[canonical].label : trade;
}

export function tradeRiskTier(trade: string): 'HIGH' | 'LOW' {
  const canonical = canonicalServiceTrade(trade);
  // Unknown trades are rejected at every request boundary. Fail high if an
  // internal caller nevertheless asks for guidance rather than understating risk.
  return canonical ? SERVICE_TRADE_CATALOG[canonical].riskTier : 'HIGH';
}

export function riskGuidance(trade: string): string {
  return tradeRiskTier(trade) === 'HIGH'
    ? 'Higher-risk work — we strongly recommend choosing a licensed (Certified) provider. Certified providers are shown first.'
    : 'Every provider is ID-verified and police-cleared — choose by ratings and reviews.';
}

// ---------------------------------------------------------------------------
// [TRADES · GUARDRAILS §8] Profile wording. Cooking gas (LPG) and fuel are never
// sold, refilled or delivered through Swift (Petroleum and Petroleum Products
// Regulations: a GEA licence is required, with prison and forfeiture of the
// vehicle). A protected professional title is shown only by the trade whose
// checklist proves it (ICAG Act s.25; lawyers are held; medicines are banned).
// ---------------------------------------------------------------------------

// Supply verbs, and the gas or fuel they would act on. A word naming an appliance,
// a fitting or a part right after the fuel word ("gas stove", "fuel pump", "diesel
// engine") is the trade's ordinary work, not fuel, and never counts. [DS1130]
const SUPPLY = String.raw`(?:sell(?:s|ing)?|sales?|refill(?:s|ing)?|top[\s-]?ups?|topping[\s-]up|deliver(?:s|y|ies|ing)?|suppl(?:y|ies|ying|ier|iers)|provid(?:e|es|ing)|distribut(?:e|es|ing|ion|ors?)|stock(?:s|ing|ists?)?|retail(?:er|ing)?|wholesale|exchange|swap|transport(?:ing)?|carry(?:ing)?|fill(?:s|ing)?)`;
const GAS_PARTS = String.raw`(?:stoves?|cookers?|ovens?|ranges?|hobs?|appliances?|lines?|pipes?|piping|leaks?|regulators?|hoses?|fittings?|fitters?|burners?|heaters?|dryers?|grills?|connections?|installations?|valves?|meters?|detectors?|safety|boilers?|fireplaces?)\b`;
const FUEL_PARTS = String.raw`(?:efficient|lines?|pumps?|filters?|injectors?|injection|tanks?|systems?|gauges?|caps?|economy|savings?|consumption|doors?|hoses?|rails?|engines?|motors?|vehicles?|cars?|generators?|trucks?|mechanics?|lamps?|stoves?|heaters?)\b`;
const NOT_PART = (parts: string) => String.raw`(?![\s-]*${parts})`;
const FUEL_WORDS = String.raw`(?:lpg|cooking\s+gas|gas)${NOT_PART(GAS_PARTS)}|gas\s+bottles?|cylinders?|propane|butane|(?:fuel|gasoline|petrol|diesel|kerosene)${NOT_PART(FUEL_PARTS)}`;
const GAP = String.raw`\W+(?:\w+\W+){0,2}`;
const supplyPattern = (fuel: string) => new RegExp(String.raw`\b${SUPPLY}${GAP}(?:${fuel})\b|\b(?:${fuel})${GAP}${SUPPLY}\b`, 'i');
const FUEL_SUPPLY = supplyPattern(FUEL_WORDS);
/** A gas fitter's "tank" is a gas tank. */
const GAS_FITTER_SUPPLY = supplyPattern(String.raw`${FUEL_WORDS}|tanks?`);
const ACCOUNTANT_TITLES = /\b(?:chartered\s+accountants?|certified\s+(?:public\s+)?accountants?|cpa|acca)\b/i;
// Lawyers are held (Code of Conduct advertising rule; touting): no profile offers legal work.
const NEVER_TITLES = /\b(?:attorney[\s-]+at[\s-]+law|barristers?|solicitors?|lawyers?|legal\s+(?:advice|services?|representation|counsel)|pharmacists?|druggists?)\b|(?<!power\s+of\s+)\battorneys?\b/i;

/** Refuse profile wording Swift must never publish for a service provider. */
export function assertProviderProfileWording(trade: ServiceTradeId, bio: string | null | undefined): void {
  if (!bio) return;
  if ((trade === 'gas_fitter' ? GAS_FITTER_SUPPLY : FUEL_SUPPLY).test(bio)) {
    throw new AppError(400, 'PROHIBITED_SERVICE_WORDING', 'Swift does not allow selling, refilling or delivering cooking gas (LPG) or fuel. Remove it from your profile.');
  }
  if (NEVER_TITLES.test(bio) || (trade !== 'accountant' && ACCOUNTANT_TITLES.test(bio))) {
    throw new AppError(400, 'PROTECTED_TITLE', 'Your profile uses a professional title that this service on Swift does not check. Remove the title from your profile.');
  }
}

const DRONE_WORDS = String.raw`(?:drones?|aerial|uavs?|quad[\s-]?copters?|fpv)`;
/** "No drone work", "drone-free", "without drones": a provider who says they do not fly. */
const NO_DRONE = new RegExp(String.raw`\b(?:no|not|never|without|don['’]?t\s+(?:do|offer|fly|use))\s+(?:\w+\s+){0,2}?${DRONE_WORDS}\b|\b${DRONE_WORDS}[\s-]*free\b`, 'gi');
const DRONE = new RegExp(String.raw`\b${DRONE_WORDS}\b`, 'i');

/** [TRADES] A profile offering drone or aerial work needs the GCAA's authorisation (services.service). */
export function profileOffersDroneWork(bio: string | null | undefined): boolean {
  return !!bio && DRONE.test(bio.replace(NO_DRONE, ' '));
}

/** A credential can only badge the exact trade selected when it was submitted.
 * GEI is specifically an electrician credential; generic qualifications still
 * require a trusted reviewer and remain bound to their submitted trade. */
export function qualificationTypeMatchesTrade(type: QualificationType, trade: ServiceTradeId): boolean {
  return type !== 'GEI_LICENCE' || trade === 'electrician';
}
