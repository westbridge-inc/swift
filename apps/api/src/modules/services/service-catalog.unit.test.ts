import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  canonicalServiceTrade, publicServiceCatalog, requireCanonicalServiceTrade,
  SERVICE_TRADE_CATALOG, qualificationTypeMatchesTrade,
} from './service-catalog';
import { providerChecklist } from './services.service';
import { serviceCatalogRoutes } from './service-catalog.routes';
import { VerificationService } from '../verification/verification.service';

describe('service catalogue authority', () => {
  it('serves every canonical category through the actual route without personal data', async () => {
    const app = Fastify();
    await app.register(serviceCatalogRoutes, { prefix: '/api/v1/services' });
    try {
      const response = await app.inject('/api/v1/services/catalog');
      expect(response.statusCode).toBe(200);
      const catalog = response.json().data;
      expect(catalog.categories.map((category: { id: string }) => category.id)).toEqual(Object.keys(SERVICE_TRADE_CATALOG));
      expect(catalog.categories).toHaveLength(29);
      expect(response.body).not.toContain('userId');
    } finally {
      await app.close();
    }
  });

  it.each(['barbering', 'hair stylist', 'tutoring'])('keeps the %s alias canonical but held until its checks exist', (alias) => {
    const trade = canonicalServiceTrade(alias)!;
    expect(trade).not.toBeNull();
    expect(() => requireCanonicalServiceTrade(alias)).toThrow('not accepting profiles or requests yet');
    const category = publicServiceCatalog().categories.find((entry) => entry.id === trade)!;
    expect(category.quoteRequestsEnabled).toBe(false);
    expect(category.modes).toEqual(['QUOTE_JOB']);
    expect(category.appointmentsEnabled).toBe(false);
  });

  it('still accepts a configured quote service', () => {
    expect(requireCanonicalServiceTrade('plumber')).toBe('plumber');
    expect(publicServiceCatalog().categories.find((entry) => entry.id === 'plumber')?.quoteRequestsEnabled).toBe(true);
  });

  it.each(['lawyer', 'attorney at law', 'accountant', 'tax consultation'])('refuses unverified professional activation: %s', (alias) => {
    expect(canonicalServiceTrade(alias)).not.toBeNull();
    expect(() => requireCanonicalServiceTrade(alias)).toThrow('not accepting profiles or requests yet');
    const category = publicServiceCatalog().categories.find((entry) => entry.id === canonicalServiceTrade(alias))!;
    expect(category.modes).toEqual(['QUOTE_JOB']);
    expect(category.quoteRequestsEnabled).toBe(false);
  });

  it('does not grant new regulated providers authority through a pre-existing base checklist', async () => {
    const db = {
      user: { findUnique: async () => ({ countryCode: 'GY' }) },
      countryConfig: { findUnique: async () => ({ documentChecklists: { SERVICE_PROVIDER: ['national_id', 'police_clearance'] } }) },
      serviceProvider: { findUnique: async () => ({ trade: 'lawyer' }) },
    };
    expect(await providerChecklist(db as never, 'synthetic-user')).toEqual([]);
  });

  it('keeps configured country/trade checklist composition for existing services', async () => {
    const db = {
      user: { findUnique: async () => ({ countryCode: 'GY' }) },
      countryConfig: { findUnique: async () => ({ documentChecklists: {
        SERVICE_PROVIDER: ['national_id', 'police_clearance'],
        SERVICE_PROVIDER_TRADE_ELECTRICIAN: ['national_id', 'gei_electrical_licence'],
      } }) },
      serviceProvider: { findUnique: async () => ({ trade: 'electrician' }) },
    };
    expect(await providerChecklist(db as never, 'synthetic-user')).toEqual(['national_id', 'police_clearance', 'gei_electrical_licence']);
  });

  it('keeps document policy topics specific without manufacturing approved credentials', () => {
    const catalog = publicServiceCatalog();
    const documents = (id: string) => catalog.categories.find((entry) => entry.id === id)!.documents;
    expect(documents('barber').some((doc) => doc.label.includes('hygiene'))).toBe(true);
    expect(documents('lawyer').some((doc) => doc.label.includes('Right to practise'))).toBe(true);
    expect(documents('tutor').some((doc) => doc.label.includes('safeguarding'))).toBe(true);
    expect(qualificationTypeMatchesTrade('GEI_LICENCE', 'barber')).toBe(false);
    expect(qualificationTypeMatchesTrade('GEI_LICENCE', 'electrician')).toBe(true);
    expect(catalog.categories.every((category) => !category.appointmentsEnabled)).toBe(true);
  });

  it('holds every category with an unresolved policy topic at profile, request, and document gates', async () => {
    const held = publicServiceCatalog().categories.filter((category) =>
      category.documents.some((document) => document.status === 'POLICY_REVIEW_REQUIRED'));
    expect(held.map((category) => category.id)).toEqual([
      'gas_fitter', 'pest_control', 'heavy_equipment_operator', 'chef', 'caterer',
      'barber', 'hairdresser', 'tutor', 'salon', 'nail_technician', 'makeup_artist',
      'photographer', 'lawyer', 'accountant',
    ]);
    for (const category of held) {
      expect(category.quoteRequestsEnabled, category.id).toBe(false);
      expect(() => requireCanonicalServiceTrade(category.id), category.id)
        .toThrow('not accepting profiles or requests yet');
      const db = {
        user: { findUnique: async () => ({ countryCode: 'GY' }) },
        countryConfig: { findUnique: async () => ({ documentChecklists: {
          SERVICE_PROVIDER: ['national_id', 'police_clearance'],
        } }) },
        serviceProvider: { findUnique: async () => ({ trade: category.id }) },
      };
      expect(await providerChecklist(db as never, 'synthetic-user'), category.id).toEqual([]);
    }
  });

  it.each(['barber', 'lawyer'])('does not project a stored %s provider as verified with an empty checklist', async (trade) => {
    const db = {
      user: { findUnique: async () => ({ countryCode: 'GY', trustLevel: 'L1' }) },
      countryConfig: { findUnique: async () => ({ documentChecklists: {
        SERVICE_PROVIDER: ['national_id', 'police_clearance'],
      } }) },
      serviceProvider: { findUnique: async () => ({ trade }) },
      verificationDocument: { findMany: async () => [] },
    };
    const status = await new VerificationService(db as never, {} as never, {} as never)
      .getStatus('synthetic-user', 'SERVICE_PROVIDER');
    expect(status.checklist).toEqual([]);
    expect(status.missing).toEqual([]);
    expect(status.roleVerified).toBe(false);
    expect(status.categoryUnavailable).toBe(true);
  });

  it('advertises only executable booking modes on every category', () => {
    const categories = publicServiceCatalog().categories;
    for (const category of categories) {
      expect(category.modes, category.id).toEqual(['QUOTE_JOB']);
      expect(category.appointmentsEnabled, category.id).toBe(false);
    }
    for (const id of ['lawyer', 'accountant']) {
      const category = categories.find((entry) => entry.id === id)!;
      expect(category.quoteRequestsEnabled).toBe(false);
      expect(category).not.toHaveProperty('price');
    }
  });
});
