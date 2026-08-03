import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, verificationApi, partnerApi, type VehicleKind } from '../services/api';
import { maybePrimeNotifications } from '../services/notification-priming';
import { useMoverPreview } from '../stores/moverPreview';
import { PREVIEW_VERIFICATION, previewQuery } from '../lib/moverPreviewData';

const PRIVACY_NOTICE_VERSION = 'v1';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

export function useVerificationStatus<T = any>(role: string, vehicleType?: string, opts?: { poll?: boolean }) {
  // Earner preview: a prospective MOVER reads as fully approved so the GO gate
  // shows the earning experience, not a KYC wall (the real query is disabled).
  const previewMover = useMoverPreview((s) => s.preview) && role === 'MOVER';
  const q = useQuery<T>({
    queryKey: ['verification', role, vehicleType],
    queryFn: () => unwrap<T>(verificationApi.status(role, vehicleType)),
    enabled: !previewMover,
    // Onboarding screens poll so an approval flips the app to "live" within
    // seconds, not on the next cold refetch. Stops itself once verified.
    refetchInterval: opts?.poll
      ? (query) => ((query.state.data as any)?.roleVerified ? false : 15000)
      : undefined,
  });
  return previewMover ? previewQuery(PREVIEW_VERIFICATION) : q;
}

/** Public weekly price list for the partner pitch ("N days free, then X/week"). */
export function usePartnerPricing(countryCode?: string) {
  return useQuery({
    queryKey: ['pricing', countryCode ?? 'GY'],
    queryFn: () => unwrap<{
      countryCode: string;
      currencyCode: string;
      currencySymbol: string;
      trialDays: number;
      weekly: { mover: number | null; smallVendor: number | null; largeVendor: number | null };
    }>(authApi.pricing(countryCode)),
    staleTime: 60 * 60 * 1000,
  });
}

export function useBecomePartner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      role: 'MOVER' | 'VENDOR';
      vehicleType?: VehicleKind;
      vehicle?: { make: string; model: string; year: number; color: string; licensePlate: string };
      business?: {
        name: string;
        vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
        phone: string;
        addressLine1: string;
        city: string;
        region?: string;
        latitude: number;
        longitude: number;
      };
    }) => unwrap(partnerApi.become(data)),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ['verification'] });
      qc.invalidateQueries({ queryKey: ['vendor'] });
      qc.invalidateQueries({ queryKey: ['mover'] });
      // Application in / store created — the earner's first obviously-useful
      // notification moment [first-open SO-5].
      maybePrimeNotifications(variables.role === 'MOVER' ? 'driver_application' : 'store_created');
    },
  });
}

/** Upload a single picked file to storage; resolves to its fileUrl. */
export function useUploadFile() {
  return useMutation({
    mutationFn: async (file: { uri: string; name: string; type: string }) => {
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
      const up = await unwrap<{ url: string }>(verificationApi.upload(form));
      return up.url;
    },
  });
}

/** Consumer L2: submit a government ID + selfie (manual KYC review). */
export function useSubmitIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { idDocumentUrl: string; selfieUrl: string }) =>
      unwrap(verificationApi.submitIdentity({ ...data, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification'] }),
  });
}

/** Upload a picked file to storage, then submit it as a checklist document. */
export function useUploadDocument(role: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docType, file }: { docType: string; file: { uri: string; name: string; type: string } }) => {
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
      const uploaded = await unwrap<{ url: string }>(verificationApi.upload(form));
      return unwrap(
        verificationApi.submitDocument({
          role,
          docType,
          fileUrl: uploaded.url,
          consent: true,
          privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        }),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verification', role] }),
  });
}
