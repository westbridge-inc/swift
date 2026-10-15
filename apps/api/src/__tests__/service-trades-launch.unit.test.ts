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
import { ALWAYS_REVIEW_LEGACY_CODES, AUTO_APPROVE_EXPIRY_DAYS, BUCKET_OF, CERTIFICATE_YEAR_DOC_TYPES } from '../modules/verification/doc-registry';
import { certificateYearRecheck, resolveApprovalExpiry } from '../modules/verification/verification.service';
import { reviewerTypedFields } from '../modules/verification/identity-signal-policy';

// ---------------------------------------------------------------------------
// [TRADES · owner 13 Oct 2026, decisions 23 + 40; R15 · owner 15 Oct 2026, research A9/D9]
// The held service trades open with the Guyana document checks the research
// confirms; the ones it marks UNSURE stay held: gas fitters, the barber group
// (barber, hairdresser, salon, nail technician, makeup artist) and accountants,
// with lawyers (counsel first). Drone work is held for every trade. Every opened
// trade keeps the base (national ID + police clearance); the trade's own
// documents are a floor a stored config edit cannot remove — no trade ever goes
// live on ID alone. Licences and food certificates are checked every January.
// ---------------------------------------------------------------------------

const BASE = ['national_id', 'police_clearance'];

/** The per-trade checklist of every trade opened at launch (owner 13 + 15 Oct). */
const EXPECTED: Record<string, string[]> = {
  pest_control: [...BASE, 'pest_control_operator_licence', 'pesticide_applicator_certificate'],
  heavy_equipment_operator: [...BASE, 'drivers_licence'],
  chef: [...BASE, 'food_handler_cert'],
  caterer: [...BASE, 'food_handler_cert', 'eating_house_registration'],
  photographer: [...BASE],
  tutor: [...BASE],
};
const OPENED = Object.keys(EXPECTED) as ServiceTradeId[];
/** [R15] research A9: UNSURE — held, with the lawyer. */
const HELD: ServiceTradeId[] = ['lawyer', 'gas_fitter', 'barber', 'hairdresser', 'salon', 'nail_technician', 'makeup_artist', 'accountant'];
const NEW_DOC_TYPES = ['pest_control_operator_licence', 'pesticide_applicator_certificate', 'eating_house_registration'];
/** [R15] the document types of the held trades are gone from the registry and the lists */
const DROPPED_DOC_TYPES = [
  'chartered_accountant_practising_certificate', 'gra_practice_certificate', 'town_clerk_registration',
  'town_clerk_shop_certificate', 'drone_authorisation',
];

function fakeDb(trade: string, lists: Record<string, string[]>, bio: string | null = null) {
  return {
    user: { findUnique: async () => ({ countryCode: 'GY' }) },
    countryConfig: { findUnique: async () => ({ documentChecklists: lists }) },
    serviceProvider: { findUnique: async () => ({ trade, bio }) },
  } as never;
}

describe('[TRADES · R15] the research-confirmed trades open with their own checks; the UNSURE ones stay held', () => {
  it('exactly the six decided trades open', () => {
    expect(OPENED).toHaveLength(6);
    for (const trade of OPENED) {
      expect(isServiceCategoryOperational(trade), trade).toBe(true);
      expect(requireCanonicalServiceTrade(trade), trade).toBe(trade);
      const category = publicServiceCatalog().categories.find((entry) => entry.id === trade)!;
      expect(category.quoteRequestsEnabled, trade).toBe(true);
    }
  });

  it.each(HELD)('%s stays held: no profile, no request, an under-review topic, no checklist', async (trade) => {
    expect(isServiceCategoryOperational(trade), trade).toBe(false);
    expect(() => requireCanonicalServiceTrade(trade)).toThrow('not accepting profiles or requests yet');
    const category = publicServiceCatalog().categories.find((entry) => entry.id === trade)!;
    expect(category.quoteRequestsEnabled).toBe(false);
    expect(category.documents.some((document) => document.status === 'POLICY_REVIEW_REQUIRED')).toBe(true);
    // a stored list cannot open it
    const lists = { SERVICE_PROVIDER: BASE, [`SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}`]: ['national_id'] };
    expect(await providerChecklist(fakeDb(trade, lists), 'synthetic-user')).toEqual([]);
    expect(SERVICE_TRADE_LAUNCH_FLOOR).not.toHaveProperty(trade);
    expect(DEFAULT_DOCUMENT_CHECKLISTS).not.toHaveProperty(`SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}`);
  });

  it.each(['lawyer', 'attorney', 'attorney at law', 'legal consultation', 'barbering', 'hair stylist', 'beautician', 'manicure', 'make up artist', 'tax consultation'])('a held trade is held by every alias: %s', (alias) => {
    expect(() => requireCanonicalServiceTrade(alias)).toThrow('not accepting profiles or requests yet');
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

  it('drone or aerial work is held: a stored profile that offers it has no checklist, so it is never verified', async () => {
    const stored = { SERVICE_PROVIDER: BASE };
    for (const bio of ['Weddings and drone shots', 'Aerial photography of your property', 'UAV video', 'Quad-copter video', 'FPV flying for events']) {
      expect(await providerChecklist(fakeDb('photographer', stored, bio), 'synthetic-user'), bio).toEqual([]);
      expect(await providerChecklist(fakeDb('tutor', stored, bio), 'synthetic-user'), bio).toEqual([]);
    }
    // a negation elsewhere in the sentence does not hide drone work: when unsure, it is drone work
    for (const bio of ['Drone photos, not just stills', 'Not just drone work', 'We do not just drone work', 'We don’t only do drone shots']) {
      expect(await providerChecklist(fakeDb('photographer', stored, bio), 'synthetic-user'), bio).toEqual([]);
    }
    // a provider who says they do NOT fly keeps the ordinary checklist
    for (const bio of ['Portraits and events', 'No drone work', 'A drone-free studio', 'Portraits only, without drones', 'We avoid drone jobs', 'doesn’t fly drones', 'Drone work not offered']) {
      expect(await providerChecklist(fakeDb('photographer', stored, bio), 'synthetic-user'), bio).toEqual(BASE);
    }
    expect(DEFAULT_DOCUMENT_CHECKLISTS).not.toHaveProperty('SERVICE_PROVIDER_TRADE_PHOTOGRAPHER_OPTIONAL');
  });

  it('a profile that offers drone or aerial work is refused, whatever the trade', () => {
    for (const bio of ['Weddings and drone shots', 'Aerial photography of your property', 'Not just drone work']) {
      for (const trade of ['photographer', 'tutor', 'carpenter'] as ServiceTradeId[]) {
        expect(() => assertProviderProfileWording(trade, bio), `${trade}: ${bio}`).toThrow(expect.objectContaining({ code: 'DRONE_WORK_HELD' }));
      }
    }
    for (const bio of ['Portraits and events', 'No drone work', 'Drone work not offered']) {
      expect(() => assertProviderProfileWording('photographer', bio), bio).not.toThrow();
    }
  });

  it('no opened trade has documents it MAY add any more (the shop and drone add-ons belonged to held work)', async () => {
    const stored = { SERVICE_PROVIDER: BASE };
    for (const trade of OPENED) {
      expect(await providerOptionalDocuments(fakeDb(trade, stored), 'synthetic-user', EXPECTED[trade]!), trade).toEqual([]);
    }
    expect(await providerOptionalDocuments(fakeDb('lawyer', stored), 'synthetic-user', [])).toEqual([]);
  });

  it('the code floor and the default lists agree, trade by trade, and only for opened trades', () => {
    expect(Object.keys(SERVICE_TRADE_LAUNCH_FLOOR).sort()).toEqual([...OPENED].sort());
    for (const trade of OPENED) {
      const floor = SERVICE_TRADE_LAUNCH_FLOOR[trade]!;
      expect(floor, trade).toEqual(EXPECTED[trade]);
      const lists = [...(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER'] ?? []), ...(DEFAULT_DOCUMENT_CHECKLISTS[`SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}`] ?? [])];
      for (const docType of floor) expect(lists, `${trade}:${docType}`).toContain(docType);
    }
  });

  it.each(DROPPED_DOC_TYPES)('%s (a held trade’s document) is gone from the registry and every list', (docType) => {
    expect(BUCKET_OF[docType]).toBeUndefined();
    expect(AUTO_APPROVE_EXPIRY_DAYS[docType]).toBeUndefined();
    expect(Object.values(DEFAULT_DOCUMENT_CHECKLISTS).flat()).not.toContain(docType);
  });
});

describe('[TRADES] every new trade document is reviewed by a person and its expiry is tracked', () => {
  it.each(NEW_DOC_TYPES)('%s expires and cannot be approved without a date', (docType) => {
    expect(AUTO_APPROVE_EXPIRY_DAYS[docType], docType).toBeGreaterThan(0);
    expect(() => resolveApprovalExpiry(docType, undefined, null)).toThrow(expect.objectContaining({ code: 'EXPIRY_REQUIRED' }));
  });

  it('the applicator certificate lasts two years (PTCCB regulation 89)', () => {
    expect(AUTO_APPROVE_EXPIRY_DAYS['pesticide_applicator_certificate']).toBe(730);
  });

  it.each(NEW_DOC_TYPES)('%s is a person’s document (purged after review) or always reviewed by a person', (docType) => {
    const bucket = BUCKET_OF[docType];
    expect(bucket, docType).toBeDefined();
    expect(bucket === 'PERSONAL' || ALWAYS_REVIEW_LEGACY_CODES.has(docType), docType).toBe(true);
  });
});

describe('[R15] licences and food certificates are checked again every January', () => {
  // 15 Oct 2026, 13:00 Guyana time; 10 Jan 2027, 09:00 Guyana time.
  const OCT = new Date('2026-10-15T17:00:00.000Z');
  const JAN = new Date('2027-01-10T13:00:00.000Z');
  const RECHECK_2027 = new Date('2027-01-16T04:00:00.000Z'); // 16 Jan 2027, 00:00 Guyana time
  const RECHECK_2028 = new Date('2028-01-16T04:00:00.000Z');

  it('names every food or licence document of an opened trade', () => {
    expect([...CERTIFICATE_YEAR_DOC_TYPES].sort()).toEqual(['eating_house_registration', 'food_handler_cert', 'gei_electrical_licence', 'pest_control_operator_licence']);
    for (const docType of CERTIFICATE_YEAR_DOC_TYPES) {
      expect(AUTO_APPROVE_EXPIRY_DAYS[docType], docType).toBeGreaterThan(0);
      expect(reviewerTypedFields(docType), docType).toEqual(['certificateYear']);
    }
  });

  it('this year’s certificate lasts to the start of 16 January next year, Guyana time', () => {
    expect(certificateYearRecheck(2026, OCT)).toEqual(RECHECK_2027);
    expect(certificateYearRecheck(2027, JAN)).toEqual(RECHECK_2028);
  });

  it('last year’s certificate is accepted only until 16 January; a later one is refused', () => {
    expect(certificateYearRecheck(2026, JAN)).toEqual(RECHECK_2027);
    expect(() => certificateYearRecheck(2026, RECHECK_2027)).toThrow(expect.objectContaining({ code: 'CERTIFICATE_YEAR_LAPSED' }));
    expect(() => certificateYearRecheck(2025, OCT)).toThrow(expect.objectContaining({ code: 'CERTIFICATE_YEAR_LAPSED', message: expect.stringMatching(/2025/) }));
  });

  it('a year that has not started, or no year, is refused', () => {
    expect(() => certificateYearRecheck(2027, OCT)).toThrow(expect.objectContaining({ code: 'CERTIFICATE_YEAR_IN_FUTURE' }));
    expect(() => certificateYearRecheck(undefined, OCT)).toThrow(expect.objectContaining({ code: 'CERTIFICATE_YEAR_REQUIRED' }));
    expect(() => certificateYearRecheck(2026.5, OCT)).toThrow(expect.objectContaining({ code: 'CERTIFICATE_YEAR_REQUIRED' }));
  });

  it.each([...CERTIFICATE_YEAR_DOC_TYPES])('%s: any other date is brought forward to the coming January re-check, never extended', (docType) => {
    const later = new Date('2027-09-30T04:00:00.000Z');
    expect(resolveApprovalExpiry(docType, later, null, OCT)).toEqual(RECHECK_2027);
    const sooner = new Date('2026-12-01T04:00:00.000Z');
    expect(resolveApprovalExpiry(docType, sooner, null, OCT)).toEqual(sooner);
    expect(() => resolveApprovalExpiry(docType, undefined, null, OCT)).toThrow(expect.objectContaining({ code: 'EXPIRY_REQUIRED' }));
  });

  it('other expiring documents keep their own rule (a driver’s licence is not capped at January)', () => {
    const later = new Date('2028-06-30T04:00:00.000Z');
    expect(resolveApprovalExpiry('drivers_licence', later, null, OCT)).toEqual(later);
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

  it('names each trade document plainly, and says what is held or checked every January', () => {
    expect(text('pest_control')).toMatch(/Pesticides and Toxic Chemicals Control Board/);
    expect(text('pest_control')).toMatch(/applicator certificate/i);
    expect(text('pest_control')).toMatch(/every January/);
    expect(text('chef')).toMatch(/food handler/i);
    expect(text('chef')).toMatch(/Georgetown only for now/);
    expect(text('chef')).toMatch(/Mayor and City Council of Georgetown/);
    expect(text('caterer')).toMatch(/eating-house registration/i);
    expect(text('caterer')).toMatch(/Georgetown only for now/);
    expect(text('heavy_equipment_operator')).toMatch(/driver’s licence/i);
    expect(text('photographer')).toMatch(/Drone or aerial work is not offered on Swift yet/);
    expect(text('tutor')).toMatch(/children/i);
    for (const trade of HELD) expect(text(trade), trade).not.toMatch(/Town Clerk|ICAG|GCAA|cooking gas/);
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
