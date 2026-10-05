import { describe, expect, it } from 'vitest';
import type { ServiceCategory } from '@swift/types';
import { customerServiceCategories, providerVerificationPresentation, serviceRequestTrade } from './serviceCatalogPresentation';

const category: ServiceCategory = {
  id: 'barber', label: 'Barber', group: 'PERSONAL_CARE', riskTier: 'LOW',
  modes: ['QUOTE_JOB', 'APPOINTMENT'], quoteRequestsEnabled: true,
  appointmentsEnabled: false, availabilityMessage: null, documents: [],
};

describe('service request selection', () => {
  it('only enables requests from the server catalogue', () => {
    expect(serviceRequestTrade([category], 'barber')).toBe('barber');
    expect(serviceRequestTrade([], 'barber')).toBeUndefined();
    expect(serviceRequestTrade([category], 'invented')).toBeUndefined();
  });
  it('closes a stale selection when the service is disabled or appointment-only', () => {
    expect(serviceRequestTrade([{ ...category, quoteRequestsEnabled: false }], 'barber')).toBeUndefined();
    expect(serviceRequestTrade([{ ...category, modes: ['APPOINTMENT'] }], 'barber')).toBeUndefined();
  });

  it('does not expose policy-held categories to customer discovery', () => {
    const available = { ...category, id: 'plumber', label: 'Plumber' };
    expect(customerServiceCategories([{ ...category, quoteRequestsEnabled: false }, available]))
      .toEqual([available]);
  });

  it('shows an explicit policy hold on a stored provider dashboard', () => {
    expect(providerVerificationPresentation({ roleVerified: false, categoryUnavailable: true }, false))
      .toEqual({
        label: 'Checks pending',
        description: 'This service is unavailable while its required checks are prepared.',
        live: false,
      });
    expect(providerVerificationPresentation({ roleVerified: false, categoryUnavailable: true }, true).live).toBe(false);
  });
});
