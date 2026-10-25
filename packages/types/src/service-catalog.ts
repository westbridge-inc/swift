/** Public catalogue metadata, never evidence of a provider's approval. */
export type ServiceBookingMode = 'QUOTE_JOB' | 'APPOINTMENT';
export interface ServiceCategoryDocument {
  key: string;
  label: string;
  status: 'COUNTRY_CHECKLIST' | 'POLICY_REVIEW_REQUIRED';
}
export interface ServiceCategory {
  id: string;
  label: string;
  group: 'HOME_AND_TRADES' | 'PERSONAL_CARE' | 'EDUCATION' | 'EVENTS' | 'PROFESSIONAL';
  riskTier: 'HIGH' | 'LOW';
  modes: ServiceBookingMode[];
  quoteRequestsEnabled: boolean;
  appointmentsEnabled: false;
  availabilityMessage: string | null;
  documents: ServiceCategoryDocument[];
}
export interface ServiceCatalog {
  version: 1;
  categories: ServiceCategory[];
  documentNotice: string;
}
