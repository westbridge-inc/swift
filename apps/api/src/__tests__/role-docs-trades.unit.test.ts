import { describe, expect, it } from 'vitest';
import {
  isServiceCategoryOperational,
  publicServiceCatalog,
  requireCanonicalServiceTrade,
  type ServiceTradeId,
} from '../modules/services/service-catalog';
import { providerChecklist, TRADE_LICENCE_DOC_TYPES, tradeLicencesOf } from '../modules/services/services.service';
import { DEFAULT_DOCUMENT_CHECKLISTS, PLATFORM_CONFIG_VERSION, SERVICE_TRADE_LAUNCH_FLOOR } from '../modules/ops/platform-config';

// ---------------------------------------------------------------------------
// [ROLE-DOCS · owner ruling 21 Oct 2026 · PR 3 of 4; COORD plan 21 Oct] Each service trade asks exactly what Guyana
// law requires:
//  - a solar / generator / inverter installer does electrical installation work, so it needs the same GEI electrical
//    licence as an electrician (Electricity Sector Reform Act: electrical installation work by a licensed electrician
//    or contractor; GPL's grid-tie certificate is applied for by one) — a floor no stored list can remove;
//  - the AC & refrigeration technician (NOAU retrofitter licences exist, their legal basis was not found) and the
//    furniture mover (a goods vehicle for reward, MVRTA s.87 goods licence: a counsel item) are HELD: the owner's rule
//    is "not clear = held";
//  - the trades the research found no licence for stay open on the ID and the police clearance.
// ---------------------------------------------------------------------------

const BASE = ['national_id', 'police_clearance'];
const SOLAR: ServiceTradeId = 'solar_generator_inverter_installer';
const NEWLY_HELD: ServiceTradeId[] = ['ac_refrigeration', 'mover'];
const STILL_OPEN_ON_ID: ServiceTradeId[] = [
  'carpenter', 'cleaner', 'mechanic', 'painter', 'mason', 'welder', 'gardener', 'appliance_electronics_repair', 'tiler',
  'party_organizer', 'plumber',
];

function fakeDb(trade: string, lists: Record<string, string[]>) {
  return {
    user: { findUnique: async () => ({ countryCode: 'GY' }) },
    countryConfig: { findUnique: async () => ({ documentChecklists: lists }) },
    serviceProvider: { findUnique: async () => ({ trade, bio: null }) },
  } as never;
}

describe('[ROLE-DOCS · PR 3] each trade asks exactly what the law requires', () => {
  it('a solar / generator / inverter installer needs the GEI electrical licence, like an electrician', async () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER_TRADE_SOLAR_GENERATOR_INVERTER_INSTALLER']).toEqual(['gei_electrical_licence']);
    expect(SERVICE_TRADE_LAUNCH_FLOOR[SOLAR]).toEqual([...BASE, 'gei_electrical_licence']);
    // a deployed row written before this change carries only the base list: the code's list applies under it
    expect(await providerChecklist(fakeDb(SOLAR, { SERVICE_PROVIDER: BASE }), 'synthetic-user')).toEqual([...BASE, 'gei_electrical_licence']);
    // a stored edit cannot take the licence away
    const stripped = { SERVICE_PROVIDER: ['national_id'], SERVICE_PROVIDER_TRADE_SOLAR_GENERATOR_INVERTER_INSTALLER: [] };
    expect(await providerChecklist(fakeDb(SOLAR, stripped), 'synthetic-user')).toEqual([...BASE, 'gei_electrical_licence']);
    // electrical work is the higher-risk group, and the catalogue lists the licence
    expect(isServiceCategoryOperational(SOLAR)).toBe(true);
    const category = publicServiceCatalog().categories.find((entry) => entry.id === SOLAR)!;
    expect(category.riskTier).toBe('HIGH');
    expect(category.documents.map((d) => d.key)).toEqual(expect.arrayContaining(['DOC_NATIONAL_ID', 'DOC_POLICE_CLEARANCE', 'DOC_GEI_ELECTRICAL_LICENCE']));
  });

  it.each(NEWLY_HELD)('%s is held: no profile, no request, an under-review topic, no checklist', async (trade) => {
    expect(isServiceCategoryOperational(trade)).toBe(false);
    expect(() => requireCanonicalServiceTrade(trade)).toThrow('not accepting profiles or requests yet');
    const category = publicServiceCatalog().categories.find((entry) => entry.id === trade)!;
    expect(category.quoteRequestsEnabled).toBe(false);
    expect(category.documents.some((document) => document.status === 'POLICY_REVIEW_REQUIRED')).toBe(true);
    // a stored list cannot open it, and a provider already saved under it is never verified
    const lists = { SERVICE_PROVIDER: BASE, [`SERVICE_PROVIDER_TRADE_${trade.toUpperCase()}`]: ['national_id'] };
    expect(await providerChecklist(fakeDb(trade, lists), 'synthetic-user')).toEqual([]);
    expect(SERVICE_TRADE_LAUNCH_FLOOR).not.toHaveProperty(trade);
  });

  it.each(['ac repair', 'hvac', 'refrigeration technician', 'furniture mover', 'moving service'])('a held trade is held by every alias: %s', (alias) => {
    expect(() => requireCanonicalServiceTrade(alias)).toThrow('not accepting profiles or requests yet');
  });

  it.each(STILL_OPEN_ON_ID)('%s stays open on the ID and the police clearance (no licence found)', async (trade) => {
    expect(isServiceCategoryOperational(trade)).toBe(true);
    expect(await providerChecklist(fakeDb(trade, { SERVICE_PROVIDER: BASE }), 'synthetic-user')).toEqual(BASE);
  });

  it('the licence line reads only a LICENCE the trade requires: the GEI licence and the pest-control operator licence', () => {
    expect([...TRADE_LICENCE_DOC_TYPES].sort()).toEqual(['gei_electrical_licence', 'pest_control_operator_licence']);
    expect(tradeLicencesOf(['national_id', 'police_clearance', 'gei_electrical_licence'])).toEqual(['gei_electrical_licence']);
    expect(tradeLicencesOf(SERVICE_TRADE_LAUNCH_FLOOR['pest_control']!)).toEqual(['pest_control_operator_licence']);
    // a food handler's certificate, a premises registration, an ID or a police clearance is never called a licence
    for (const trade of ['chef', 'caterer', 'tutor', 'photographer']) expect(tradeLicencesOf(SERVICE_TRADE_LAUNCH_FLOOR[trade]!), trade).toEqual([]);
  });

  it('the platform config version moves with the new solar list', () => {
    expect(PLATFORM_CONFIG_VERSION).toBe('2026-10-22.1');
  });
});
