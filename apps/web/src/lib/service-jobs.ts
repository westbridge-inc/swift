'use client';

// [W11] Local services on the web — the same API the phone app uses
// (apps/mobile services/api.ts servicesApi): the public catalogue and the
// providers for a trade, and a customer's own quote requests ("jobs"). The
// rules for which categories take requests, and for picking a time, are the
// app's own pure functions, never re-expressed here.
import type { ServiceCatalog } from '@swift/types';
import { apiFetch } from './auth';
import { BROWSER_API_ORIGIN } from './browser-api-origin';

export {
  SERVICE_GROUP_LABELS, customerServiceCategories, serviceRequestTrade, selectedServiceCategory,
} from '../../../mobile/src/modules/services/serviceCatalogPresentation';
export { formatAppointmentSlot, serviceJobScheduleSelection, upcomingAppointmentDays } from '../../../mobile/src/lib/appointmentTime';

export interface ServiceProviderCard {
  id: string;
  trade: string;
  tradeLabel: string;
  bio: string | null;
  displayRating: number | null;
  ratingBucket?: string;
  totalRatings: number;
  certified: boolean;
  selfSkilled: boolean;
  badges: string[];
}

export interface ProviderPage {
  trade: string;
  tradeLabel: string;
  riskTier: 'HIGH' | 'LOW';
  guidance?: string | null;
  providers: ServiceProviderCard[];
  page: { limit: number; nextCursor: string | null };
}

export interface ServiceJob {
  id: string;
  customerId: string;
  providerId: string;
  description: string;
  status: 'REQUESTED' | 'QUOTED' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | string;
  quoteAmount: string | number | null;
  scheduledFor: string | null;
  providerConfirmedAt: string | null;
  createdAt: string;
  provider?: { trade?: string; user?: { firstName?: string | null } | null } | null;
}

async function publicRead<T>(path: string): Promise<T> {
  const response = await fetch(`${BROWSER_API_ORIGIN}${path}`, { cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success === false) throw new Error(body?.error?.message || 'We couldn’t load this. Please try again.');
  return body.data as T;
}

export const servicesApi = {
  catalog: () => publicRead<ServiceCatalog>('/api/v1/services/catalog'),
  providers: (trade: string, cursor?: string) =>
    publicRead<ProviderPage>(`/api/v1/services/providers?${new URLSearchParams({ trade, ...(cursor ? { cursor } : {}) })}`),
  request: async (providerId: string, description: string) =>
    (await apiFetch('/api/v1/services/jobs', { method: 'POST', body: JSON.stringify({ providerId, description }) })).data as ServiceJob,
  jobs: async () => (await apiFetch('/api/v1/services/jobs')).data as ServiceJob[],
  job: async (id: string) => (await apiFetch(`/api/v1/services/jobs/${encodeURIComponent(id)}`)).data as ServiceJob,
  schedule: async (id: string, scheduledFor: string) =>
    (await apiFetch(`/api/v1/services/jobs/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify({ scheduledFor }) })).data as ServiceJob,
  cancel: async (id: string) =>
    (await apiFetch(`/api/v1/services/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) })).data as ServiceJob,
  rate: async (id: string, score: number) =>
    (await apiFetch(`/api/v1/services/jobs/${encodeURIComponent(id)}/rate`, { method: 'POST', body: JSON.stringify({ score }) })).data,
};

/** The app's words for a job's state (ServiceJobsScreen STATUS_LABEL). */
export const JOB_STATUS: Record<string, string> = {
  REQUESTED: 'Waiting for a quote',
  QUOTED: 'Quote received',
  SCHEDULED: 'Booked',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** The hours a customer can book, as in the app. */
export const BOOKING_HOURS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

/** Someone is on the way or on site: the window where help must be one tap away. */
export const ON_SITE = new Set(['SCHEDULED', 'IN_PROGRESS']);
