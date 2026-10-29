import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { servicesApi } from '../services/api';
import { track } from '../lib/analytics';
import { unwrapOptionalServiceProviderProfile } from '../lib/serviceProviderProfile';
import {
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../stores/authStore';
import { serviceProviderProfileRefetchInterval } from './verificationPolling';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

export function useServiceProviders<T = any>(trade?: string) {
  return useQuery<T>({
    queryKey: ['services', 'providers', trade],
    queryFn: () => unwrap<T>(servicesApi.providers(trade as string)),
    enabled: !!trade,
  });
}

/** A 404 is the valid "start onboarding" state. Auth, network, and 5xx
 * failures remain visible errors so the app never invents an empty profile. */
export function useServiceProviderProfile<T = any>() {
  const userId = useAuthStore((state) => state.user?.id);
  return useQuery<T | null>({
    queryKey: ['services', 'provider-me', userId],
    queryFn: async () => {
      const owner = requireAuthSessionSnapshot();
      const provider = await unwrapOptionalServiceProviderProfile<T>(servicesApi.providerMe(owner));
      requireAuthSessionForPrincipal(owner);
      return provider;
    },
    enabled: !!userId,
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * (2 ** attempt), 2_000),
    // Approval updates ServiceProvider.isVerified server-side. A policy-held
    // profile cannot progress through polling; an edit invalidates this query.
    refetchInterval: (query) => serviceProviderProfileRefetchInterval(
      query.state.data as { isVerified?: boolean; categoryUnavailable?: boolean } | null | undefined,
    ),
  });
}

export function useSaveServiceProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { trade: string; bio?: string; portfolioPhotos?: string[] }) => {
      const owner = requireAuthSessionSnapshot();
      const result = await unwrap(servicesApi.saveProvider(data, owner));
      requireAuthSessionForPrincipal(owner);
      return result;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['services', 'provider-me'] });
      void qc.invalidateQueries({ queryKey: ['services', 'providers'] });
      void qc.invalidateQueries({ queryKey: ['verification', 'SERVICE_PROVIDER'] });
    },
  });
}

export function useAddServiceQualification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      type: 'CVQ' | 'GTEE' | 'CITY_AND_GUILDS' | 'OTHER';
      referenceNumber?: string;
    }) => {
      const owner = requireAuthSessionSnapshot();
      const result = await unwrap(servicesApi.addQualification(data, owner));
      requireAuthSessionForPrincipal(owner);
      return result;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['services', 'provider-me'] }),
  });
}

export function useServiceJobs<T = any>() {
  return useQuery<T>({ queryKey: ['services', 'jobs'], queryFn: () => unwrap<T>(servicesApi.jobs()) });
}

export function useRequestJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { providerId: string; description: string; photos?: string[] }) =>
      unwrap(servicesApi.requestJob(data)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services', 'jobs'] });
      track('service_job_requested', {});
    },
  });
}

/** Accepting a quote = scheduling it (QUOTED → SCHEDULED, customer-only). */
export function useScheduleJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scheduledFor, expectedUpdatedAt, expectedQuoteAmount }: {
      id: string;
      scheduledFor: string;
      expectedUpdatedAt: string;
      expectedQuoteAmount: number;
    }) => unwrap(servicesApi.scheduleJob(id, { scheduledFor, expectedUpdatedAt, expectedQuoteAmount })),
    onSettled: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedUpdatedAt }: { id: string; expectedUpdatedAt: string }) =>
      unwrap(servicesApi.cancelJob(id, expectedUpdatedAt)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useRateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, score, comment }: { id: string; score: number; comment?: string }) =>
      unwrap(servicesApi.rateJob(id, score, comment)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

// Provider side (§4.3): quote, then accept/decline the customer's slot.
export function useQuoteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, expectedUpdatedAt }: { id: string; amount: number; expectedUpdatedAt: string }) =>
      unwrap(servicesApi.quoteJob(id, amount, expectedUpdatedAt)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useConfirmJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedUpdatedAt, expectedScheduledFor }: {
      id: string;
      expectedUpdatedAt: string;
      expectedScheduledFor: string;
    }) => unwrap(servicesApi.confirmJob(id, expectedUpdatedAt, expectedScheduledFor)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useStartJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedUpdatedAt, expectedScheduledFor }: {
      id: string;
      expectedUpdatedAt: string;
      expectedScheduledFor: string;
    }) => unwrap(servicesApi.startJob(id, expectedUpdatedAt, expectedScheduledFor)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useCompleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedUpdatedAt }: { id: string; expectedUpdatedAt: string }) =>
      unwrap(servicesApi.completeJob(id, expectedUpdatedAt)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

export function useDeclineSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedUpdatedAt, expectedScheduledFor }: {
      id: string;
      expectedUpdatedAt: string;
      expectedScheduledFor: string;
    }) => unwrap(servicesApi.declineSlot(id, expectedUpdatedAt, expectedScheduledFor)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['services', 'jobs'] }),
  });
}

// ---------------------------------------------------------------------------
// [BOOK-P3] Booking a pro from their list of services, moving it, and the pro's
// own list, hours and time off. Every rule (notice, cut-off, caps, price,
// agreement) is the server's: these hooks only read and send.
// ---------------------------------------------------------------------------

/** The pro's bookable services (GET /providers/:id/offerings). */
export function useProOfferings<T = any>(providerId: string) {
  return useQuery<T>({
    queryKey: ['services', 'pro-offerings', providerId],
    queryFn: () => unwrap<T>(servicesApi.proOfferings(providerId)),
    enabled: !!providerId,
    retry: false,
  });
}

/** The free start times of one service on one Guyana date. Refetched while open: a time someone
 *  else just booked disappears (the server's exclusion is still the final judge). */
export function useProSlots<T = any>(providerId: string, offeringId: string, date: string) {
  return useQuery<T>({
    queryKey: ['services', 'pro-slots', providerId, offeringId, date],
    queryFn: () => unwrap<T>(servicesApi.proSlots(providerId, offeringId, date)),
    enabled: !!providerId && !!offeringId && !!date,
    retry: false,
    refetchInterval: 20_000,
  });
}

export function useBookPro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { providerId: string; offeringId: string; scheduledFor: string; expectedPrice: number; note?: string }) =>
      unwrap(servicesApi.bookPro(input)),
    onSuccess: () => track('service_job_booked', {}),
    onSettled: (_data, _error, input) => {
      qc.invalidateQueries({ queryKey: ['services', 'jobs'] });
      qc.invalidateQueries({ queryKey: ['services', 'pro-slots', input.providerId] });
      qc.invalidateQueries({ queryKey: ['services', 'pro-offerings', input.providerId] });
    },
  });
}

/** The free times to move a booked service to (its booked length, its own time not counted). */
export function useJobSlots<T = any>(jobId: string, date: string) {
  return useQuery<T>({
    queryKey: ['services', 'job-slots', jobId, date],
    queryFn: () => unwrap<T>(servicesApi.jobSlots(jobId, date)),
    enabled: !!jobId && !!date,
    retry: false,
    refetchInterval: 20_000,
  });
}

export function useRescheduleServiceJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; scheduledFor: string; expectedUpdatedAt: string; expectedScheduledFor: string }) =>
      unwrap(servicesApi.rescheduleJob(id, input)),
    onSettled: (_data, _error, { id }) => {
      qc.invalidateQueries({ queryKey: ['services', 'jobs'] });
      qc.invalidateQueries({ queryKey: ['services', 'job-slots', id] });
    },
  });
}

const MY_BOOKABLE_KEY = ['services', 'my-bookable'] as const;

/** The pro's own list of services, weekly hours and time off (404 PRO_BOOKING_OFF while the switch is off). */
export function useMyBookable<T = any>(enabled = true) {
  return useQuery<T>({ queryKey: MY_BOOKABLE_KEY, queryFn: () => unwrap<T>(servicesApi.myBookable()), enabled, retry: false });
}

function useMyBookableMutation<I>(fn: (input: I) => Promise<any>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: I) => unwrap(fn(input)), onSettled: () => qc.invalidateQueries({ queryKey: MY_BOOKABLE_KEY }) });
}

export const useAddOffering = () => useMyBookableMutation((input: { name: string; durationMinutes: number; price: number }) => servicesApi.addOffering(input));
export const useUpdateOffering = () => useMyBookableMutation(({ id, ...input }: { id: string; name?: string; durationMinutes?: number; price?: number; active?: boolean }) => servicesApi.updateOffering(id, input));
export const useSaveProHours = () => useMyBookableMutation((slots: Array<{ dayOfWeek: number; start: string; end: string }>) => servicesApi.saveHours(slots));
export const useAddTimeOff = () => useMyBookableMutation((input: { date: string; start?: string; end?: string }) => servicesApi.addTimeOff(input));
export const useRemoveTimeOff = () => useMyBookableMutation((id: string) => servicesApi.removeTimeOff(id));
