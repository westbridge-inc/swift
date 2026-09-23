import type { QualificationType } from '@prisma/client';
import type { ServiceCatalog, ServiceCategory } from '@swift/types';
import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Services vertical (spec §4.6). Trust is risk-tiered: verify hard where someone
// could be physically harmed. Every provider needs ID + police clearance; a
// trade qualification is an optional "Certified" badge. Providers without one
// can still join, shown transparently as "self-skilled".
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
const PENDING_CATEGORIES = new Set<ServiceTradeId>([
  'gas_fitter', 'pest_control', 'heavy_equipment_operator', 'chef', 'caterer',
  'barber', 'hairdresser', 'tutor',
  'salon', 'nail_technician', 'makeup_artist', 'photographer', 'lawyer', 'accountant',
]);

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

function categoryDocuments(trade: ServiceTradeId): ServiceCategory['documents'] {
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
    barber: 'Premises registration and hygiene requirements for barbering',
    hairdresser: 'Premises registration and hygiene requirements for hairdressing',
    salon: 'Beauty service scope, premises and hygiene requirements',
    nail_technician: 'Nail service scope, hygiene and premises requirements',
    makeup_artist: 'Makeup service scope and hygiene requirements',
    tutor: 'Qualifications and safeguarding for work with children',
    photographer: 'Portfolio rights and safeguarding where children are involved',
    lawyer: 'Right to practise and current professional standing',
    accountant: 'Professional credentials and authority for the services offered',
    chef: 'Food handling and premises requirements',
    caterer: 'Food handling and premises requirements',
    gas_fitter: 'Gas work competency and applicable licence requirements',
    pest_control: 'Chemical handling and applicable licence requirements',
    heavy_equipment_operator: 'Equipment competency and applicable licence requirements',
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

/** A credential can only badge the exact trade selected when it was submitted.
 * GEI is specifically an electrician credential; generic qualifications still
 * require a trusted reviewer and remain bound to their submitted trade. */
export function qualificationTypeMatchesTrade(type: QualificationType, trade: ServiceTradeId): boolean {
  return type !== 'GEI_LICENCE' || trade === 'electrician';
}
