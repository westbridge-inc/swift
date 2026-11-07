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
  /** [BOOK-P2] True only while instant booking is on, for a category whose pros take bookings
   *  from a menu (tutor, cleaner, photographer; never a held one). Builds 9-12 do not read it. */
  appointmentsEnabled: boolean;
  availabilityMessage: string | null;
  documents: ServiceCategoryDocument[];
}
export interface ServiceCatalog {
  version: 1;
  categories: ServiceCategory[];
  documentNotice: string;
}
