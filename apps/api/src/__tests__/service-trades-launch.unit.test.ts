import { describe, expect, it } from 'vitest';
import {
  assertProviderProfileWording,
  canonicalServiceTrade,
  isServiceCategoryOperational,
  publicServiceCatalog,
  requireCanonicalServiceTrade,
  type ServiceTradeId,
} from '../modules/services/service-catalog';
import { providerChecklist, providerOptionalDocuments } from '../modules/services/services.service';
import { DEFAULT_DOCUMENT_CHECKLISTS, SERVICE_TRADE_LAUNCH_FLOOR } from '../modules/ops/platform-config';
import { ALWAYS_REVIEW_LEGACY_CODES, AUTO_APPROVE_EXPIRY_DAYS, BUCKET_OF } from '../modules/verification/doc-registry';
import { resolveApprovalExpiry } from '../modules/verification/verification.service';

// ---------------------------------------------------------------------------
// [TRADES · owner 13 Oct 2026, decisions 23 + 40] Thirteen held service trades
// open at launch, each with the Guyana document checks the research table names
// (owner/SERVICE-TRADES-CHECKLISTS-20261013). Lawyers stay held until counsel
// confirms the advertising rule and the touting risk. Every trade keeps the
// base (national ID + police clearance); the trade's own documents are a floor
// a stored config edit cannot remove — no trade ever goes live on ID alone.
// ---------------------------------------------------------------------------

const BASE = ['national_id', 'police_clearance'];

/** The per-trade checklist as the owner decided it (13 Oct). */
const EXPECTED: Record<string, string[]> = {
  gas_fitter: [...BASE],
  pest_control: [...BASE, 'pest_control_operator_licence', 'pesticide_applicator_certificate'],
  heavy_equipment_operator: [...BASE, 'drivers_licence'],
  chef: [...BASE, 'food_handler_cert'],
  caterer: [...BASE, 'food_handler_cert', 'eating_house_registration'],
  barber: [...BASE, 'town_clerk_registration'],
  hairdresser: [...BASE, 'town_clerk_registration'],
  salon: [...BASE, 'town_clerk_registration', 'town_clerk_shop_certificate'],
  nail_technician: [...BASE, 'town_clerk_registration'],
  makeup_artist: [...BASE, 'town_clerk_registration'],
  photographer: [...BASE],
  tutor: [...BASE],
  accountant: [...BASE, 'chartered_accountant_practising_certificate', 'gra_practice_certificate'],
};
const OPENED = Object.keys(EXPECTED) as ServiceTradeId[];
const NEW_DOC_TYPES = [
  'pest_control_operator_licence', 'pesticide_applicator_certificate',
  'chartered_accountant_practising_certificate', 'gra_practice_certificate',
  'eating_house_registration', 'town_clerk_registration', 'town_clerk_shop_certificate',
  'drone_authorisation',
];

function fakeDb(trade: string, lists: Record<string, string[]>, bio: string | null = null) {
  return {
    user: { findUnique: async () => ({ countryCode: 'GY' }) },
    countryConfig: { findUnique: async () => ({ documentChecklists: lists }) },
    serviceProvider: { findUnique: async () => ({ trade, bio }) },
  } as never;
}

describe('[TRADES] the 13 held trades open at launch with their own checks', () => {
  it('exactly thirteen trades open; only the lawyer stays held', () => {
    expect(OPENED).toHaveLength(13);
    for (const trade of OPENED) {
      expect(isServiceCategoryOperational(trade), trade).toBe(true);
      expect(requireCanonicalServiceTrade(trade), trade).toBe(trade);
      const category = publicServiceCatalog().categories.find((entry) => entry.id === trade)!;
      expect(category.quoteRequestsEnabled, trade).toBe(true);
    }
    expect(isServiceCategoryOperational('lawyer')).toBe(false);
  });

  it.each(['lawyer', 'attorney', 'attorney at law', 'legal consultation'])('keeps the lawyer category held: %s', (alias) => {
    expect(canonicalServiceTrade(alias)).toBe('lawyer');
    expect(() => requireCanonicalServiceTrade(alias)).toThrow('not accepting profiles or requests yet');
    const category = publicServiceCatalog().categories.find((entry) => entry.id === 'lawyer')!;
    expect(category.quoteRequestsEnabled).toBe(false);
    expect(category.documents.some((document) => document.status === 'POLICY_REVIEW_REQUIRED')).toBe(true);
  });

  it('a stored lawyer list cannot open the lawyer category', async () => {
    const lists = { SERVICE_PROVIDER: BASE, SERVICE_PROVIDER_TRADE_LAWYER: ['national_id'] };
    expect(await providerChecklist(fakeDb('lawyer', lists), 'synthetic-user')).toEqual([]);
  });

  it.each(OPENED)('%s gets its decided checklist from the code defaults when the stored row predates it', async (trade) => {
    // A deployed CountryConfig row written before this change carries only the base list.
    const stored = { SERVICE_PROVIDER: BASE };
    expect(await providerChecklist(fakeDb(trade, stored), 'synthetic-user')).toEqual(EXPECTED[trade]);
  });

  it.each(OPENED)('%s never goes live on identity alone: a stored edit cannot drop its floor', async (trade) => {
    const key = `SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}`;
    const stored = { SERVICE_PROVIDER: ['national_id'], [key]: [] };
    const checklist = await providerChecklist(fakeDb(trade, stored), 'synthetic-user');
    expect(checklist).toEqual(EXPECTED[trade]);
    expect(checklist).toContain('police_clearance');
  });

  it('a tutor always needs a police clearance (children, home visits) — never optional', async () => {
    const stored = { SERVICE_PROVIDER: ['national_id'], SERVICE_PROVIDER_OPTIONAL: ['police_clearance'] };
    expect(await providerChecklist(fakeDb('tutor', stored), 'synthetic-user')).toContain('police_clearance');
    expect(SERVICE_TRADE_LAUNCH_FLOOR['tutor']).toContain('police_clearance');
  });

  it('a provider whose profile offers drone or aerial work must show a drone authorisation', async () => {
    const stored = { SERVICE_PROVIDER: BASE };
    for (const bio of ['Weddings and drone shots', 'Aerial photography of your property', 'UAV video']) {
      expect(await providerChecklist(fakeDb('photographer', stored, bio), 'synthetic-user'), bio).toEqual([...BASE, 'drone_authorisation']);
    }
    expect(await providerChecklist(fakeDb('photographer', stored, 'Portraits and events'), 'synthetic-user')).toEqual(BASE);
    // [DS1130 S4] other spellings count; a provider who says they do NOT fly is not asked
    for (const bio of ['Quad-copter video', 'FPV flying for events']) {
      expect(await providerChecklist(fakeDb('photographer', stored, bio), 'synthetic-user'), bio).toEqual([...BASE, 'drone_authorisation']);
    }
    for (const bio of ['No drone work', 'A drone-free studio', 'Portraits only, without drones', 'We avoid drone jobs', 'doesn’t fly drones', 'Drone work not offered']) {
      expect(await providerChecklist(fakeDb('photographer', stored, bio), 'synthetic-user'), bio).toEqual(BASE);
    }
    // a negation elsewhere in the sentence does not hide drone work: when unsure, Swift asks
    for (const bio of ['Drone photos, not just stills', 'Not just drone work', 'We do not just drone work', 'We don’t only do drone shots']) {
      expect(await providerChecklist(fakeDb('photographer', stored, bio), 'synthetic-user'), bio).toEqual([...BASE, 'drone_authorisation']);
    }
    // The authorisation is offered to every photographer as a document they MAY add first.
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER_TRADE_PHOTOGRAPHER_OPTIONAL']).toEqual(['drone_authorisation']);
  });

  it('a personal-care worker may add the shop certificate; a salon must hold it', () => {
    for (const trade of ['barber', 'hairdresser', 'nail_technician', 'makeup_artist']) {
      expect(DEFAULT_DOCUMENT_CHECKLISTS[`SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}_OPTIONAL`], trade).toEqual(['town_clerk_shop_certificate']);
    }
    expect(EXPECTED['salon']).toContain('town_clerk_shop_certificate');
  });

  it('the documents a provider MAY add come from the code defaults when the stored row predates them', async () => {
    const stored = { SERVICE_PROVIDER: BASE };
    expect(await providerOptionalDocuments(fakeDb('barber', stored), 'synthetic-user', EXPECTED['barber']!)).toEqual(['town_clerk_shop_certificate']);
    expect(await providerOptionalDocuments(fakeDb('photographer', stored), 'synthetic-user', BASE)).toEqual(['drone_authorisation']);
    // never a document the checklist already requires, and nothing for a held category
    expect(await providerOptionalDocuments(fakeDb('photographer', stored, 'drone work'), 'synthetic-user', [...BASE, 'drone_authorisation'])).toEqual([]);
    expect(await providerOptionalDocuments(fakeDb('lawyer', stored), 'synthetic-user', [])).toEqual([]);
  });

  it('the code floor and the default lists agree, trade by trade', () => {
    for (const trade of OPENED) {
      const floor = SERVICE_TRADE_LAUNCH_FLOOR[trade]!;
      expect(floor, trade).toEqual(EXPECTED[trade]);
      const lists = [...(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER'] ?? []), ...(DEFAULT_DOCUMENT_CHECKLISTS[`SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}`] ?? [])];
      for (const docType of floor) expect(lists, `${trade}:${docType}`).toContain(docType);
    }
    expect(SERVICE_TRADE_LAUNCH_FLOOR).not.toHaveProperty('lawyer');
  });
});

describe('[TRADES] every new trade document is reviewed by a person and its expiry is tracked', () => {
  it.each(NEW_DOC_TYPES)('%s expires and cannot be approved without a keyed date', (docType) => {
    expect(AUTO_APPROVE_EXPIRY_DAYS[docType], docType).toBeGreaterThan(0);
    expect(() => resolveApprovalExpiry(docType, undefined, null)).toThrow(expect.objectContaining({ code: 'EXPIRY_REQUIRED' }));
  });

  it('the applicator certificate lasts two years (PTCCB regulation 89); the yearly ones one year', () => {
    expect(AUTO_APPROVE_EXPIRY_DAYS['pesticide_applicator_certificate']).toBe(730);
    for (const docType of ['chartered_accountant_practising_certificate', 'gra_practice_certificate', 'eating_house_registration', 'town_clerk_registration', 'town_clerk_shop_certificate', 'drone_authorisation']) {
      expect(AUTO_APPROVE_EXPIRY_DAYS[docType], docType).toBe(365);
    }
  });

  it.each(NEW_DOC_TYPES)('%s is a person’s document (purged after review) or always reviewed by a person', (docType) => {
    const bucket = BUCKET_OF[docType];
    expect(bucket, docType).toBeDefined();
    expect(bucket === 'PERSONAL' || ALWAYS_REVIEW_LEGACY_CODES.has(docType), docType).toBe(true);
  });
});

describe('[TRADES] the catalogue says what each trade needs, in plain words', () => {
  const documents = (id: string) => publicServiceCatalog().categories.find((entry) => entry.id === id)!.documents;
  const text = (id: string) => documents(id).map((document) => document.label).join(' | ');

  it.each(OPENED)('%s shows its checks and no "under review" topic', (trade) => {
    expect(documents(trade).every((document) => document.status === 'COUNTRY_CHECKLIST'), trade).toBe(true);
    expect(text(trade)).toMatch(/police clearance/i);
    expect(text(trade)).toMatch(/national ID/i);
  });

  it('names each trade document plainly', () => {
    expect(text('pest_control')).toMatch(/Pesticides and Toxic Chemicals Control Board/);
    expect(text('pest_control')).toMatch(/applicator certificate/i);
    expect(text('accountant')).toMatch(/ICAG/);
    expect(text('accountant')).toMatch(/GRA practice certificate/);
    expect(text('chef')).toMatch(/food handler/i);
    expect(text('caterer')).toMatch(/eating-house registration/i);
    expect(text('heavy_equipment_operator')).toMatch(/driver’s licence/i);
    for (const trade of ['barber', 'hairdresser', 'salon', 'nail_technician', 'makeup_artist']) expect(text(trade), trade).toMatch(/Town Clerk/);
    expect(text('salon')).toMatch(/shop certificate/i);
    expect(text('photographer')).toMatch(/drone/i);
    expect(text('gas_fitter')).toMatch(/cooking gas \(LPG\)/);
    expect(text('tutor')).toMatch(/children/i);
  });
});

describe('[TRADES] profile wording rules', () => {
  it.each([
    'LPG cylinder refills and delivery',
    'I sell cooking gas',
    'Gas cylinder exchange, same day',
    'We deliver propane and fuel to your door',
    'Diesel for sale',
    // [DS1130 S2] bare "gas", top-ups, and the provide / distribute verbs
    'We refill gas',
    'Gas refill service',
    'Gas refills and top-ups',
    'Top-up gas cylinders',
    'Gas top-up service',
    'Cooker gas refills',
    'We provide LPG',
    'We sell gas',
    'LPG distributor for the East Coast',
    'We stock cooking gas',
    // [DS1132 S2] past tenses and the people who sell it
    'Cooking gas delivered to your door',
    'LPG sold and delivered',
    'Gas refilled while you wait',
    'Propane and butane supplied daily',
    'Fuel stocked all week',
    'Kerosene vendors',
    'We are diesel dealers',
    'We filled your gas tank',
    'LPG available',
    'Cooking gas available now',
    'Order your gas from us',
    'Buy LPG here',
    // [DS1133 S2]
    'Get your LPG here',
    'Diesel by the gallon',
    // [DS1134]
    'Gas tanks available',
    'LPG here, call us',
    'Get your gas delivered',
  ])('refuses gas or fuel supply wording: %s', (bio) => {
    expect(() => assertProviderProfileWording('gas_fitter', bio)).toThrow(expect.objectContaining({ code: 'PROHIBITED_SERVICE_WORDING' }));
    expect(() => assertProviderProfileWording('plumber', bio)).toThrow(expect.objectContaining({ code: 'PROHIBITED_SERVICE_WORDING' }));
  });

  it('a gas fitter may not offer to refill a tank either', () => {
    expect(() => assertProviderProfileWording('gas_fitter', 'We refill your tank')).toThrow(expect.objectContaining({ code: 'PROHIBITED_SERVICE_WORDING' }));
    // a water-tank cleaner is not selling gas, and neither is a gas fitter fitting water tanks [DS1132 S4]
    expect(() => assertProviderProfileWording('cleaner', 'We clean and refill your water tank')).not.toThrow();
    for (const bio of ['We sell hot water tanks', 'I supply water tanks', 'Septic tanks supplied and installed']) {
      expect(() => assertProviderProfileWording('gas_fitter', bio), bio).not.toThrow();
    }
  });

  it.each([
    'I install and repair LPG stoves, regulators and lines',
    'Gas leak checks and cooker hook-ups',
    'We sell and fit gas stoves and regulators',
    'Certified gas fitter: I supply and fit new hoses',
    undefined,
  ])('allows installation and repair wording: %s', (bio) => {
    expect(() => assertProviderProfileWording('gas_fitter', bio)).not.toThrow();
  });

  it.each([
    // [DS1130 S3] parts and appliances are not fuel
    'we deliver fuel-efficient stoves',
    'supplier of fuel lines',
    'I swap fuel pumps',
    'I carry fuel filters',
    'Diesel and petrol engines; parts supply',
    'Diesel generator delivery and servicing',
    // [DS1132 S3] a filling station is a customer or a place, not fuel
    'We deliver meals for gas stations',
    'We supply meals to gas stations',
    'We deliver equipment for fuel stations',
    'We supply gas station fittings',
    'Diesel mechanic available weekends',
    'Generator fuel lines checked; parts ordered',
    'Buffet orders for gas station staff',
    'Gas stoves available to order',
    // [DS1133 S3/S4] repair availability and buying parts or equipment are not selling fuel
    'Emergency gas repairs available',
    'Gas repairs available 24/7',
    'Available for emergency gas repairs',
    'Gas repair service available',
    'We order gas parts weekly',
    'We buy gas tanks for recycling',
    'We bought a gas truck',
    // [DS1134 S3] "get your gas checked" and "we fix gas here" are the repair work itself
    'Get your gas checked',
    'Get your gas serviced',
    'Get your gas installed',
    'Get your diesel serviced',
    'We fix gas here',
    'We repair gas here',
  ])('allows ordinary trade wording that names fuel parts: %s', (bio) => {
    expect(() => assertProviderProfileWording('mechanic', bio)).not.toThrow();
    expect(() => assertProviderProfileWording('gas_fitter', bio)).not.toThrow();
  });

  it('asks a provider not to mention gas sales at all, even to say they do not sell it', () => {
    // A negation reader is how "we don't only sell gas, we deliver it" would slip through; the
    // catalogue already tells gas fitters it is installation and repair only.
    for (const bio of ['We do not sell gas', 'We are not gas dealers']) {
      expect(() => assertProviderProfileWording('gas_fitter', bio), bio).toThrow(expect.objectContaining({
        code: 'PROHIBITED_SERVICE_WORDING',
        message: expect.stringMatching(/even to say you do not/),
      }));
    }
  });

  it('keeps protected titles for the people who hold them', () => {
    expect(() => assertProviderProfileWording('accountant', 'Chartered Accountant, CPA')).not.toThrow();
    for (const bio of ['Chartered Accountant on weekends', 'CPA-level bookkeeping', 'ACCA qualified']) {
      expect(() => assertProviderProfileWording('tutor', bio), bio).toThrow(expect.objectContaining({ code: 'PROTECTED_TITLE' }));
    }
    for (const bio of ['Attorney-at-law', 'attorney at law and notary', 'Registered pharmacist', 'Druggist', 'Lawyer by day', 'Your attorney for land matters', 'Free legal advice']) {
      expect(() => assertProviderProfileWording('accountant', bio), bio).toThrow(expect.objectContaining({ code: 'PROTECTED_TITLE' }));
    }
    for (const bio of ['Paralegal services', 'Legal drafting service']) {
      expect(() => assertProviderProfileWording('tutor', bio), bio).toThrow(expect.objectContaining({ code: 'PROTECTED_TITLE' }));
    }
    // a power of attorney is a document, not a title [DS1132 S4]
    for (const bio of ['I help families prepare a power of attorney form', 'We prepare powers of attorney', 'power-of-attorney forms']) {
      expect(() => assertProviderProfileWording('tutor', bio), bio).not.toThrow();
    }
  });
});
