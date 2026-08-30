import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, verificationApi, partnerApi, type VehicleKind } from '../services/api';
import { maybePrimeNotifications } from '../services/notification-priming';
import { useMoverPreview } from '../stores/moverPreview';
import { PREVIEW_VERIFICATION, previewQuery } from '../lib/moverPreviewData';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../stores/authStore';
import { canonicalMoverAuthority } from '../lib/moverAuthorityCache';
import type { AuthSessionSnapshot } from '../lib/authSession';

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
      weekly: { mover: number | null; moverHeavy: number | null; serviceVendor: number | null; smallVendor: number | null; largeVendor: number | null; departmentVendor: number | null };
    }>(authApi.pricing(countryCode)),
    staleTime: 60 * 60 * 1000,
  });
}

export function useBecomePartner() {
  const qc = useQueryClient();
  const setUserIfCurrent = useAuthStore((s) => s.setUserIfCurrent);
  return useMutation({
    mutationFn: async (data: {
      role: 'MOVER' | 'VENDOR';
      vehicleType?: VehicleKind;
      vehicle?: { make: string; model: string; year: number; color: string; licensePlate: string };
      /** [DCR-1] The role-agreement checkbox, recorded in the consent ledger. */
      acceptAgreement?: boolean;
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
    }) => {
      const owner = requireAuthSessionSnapshot();
      const user = useAuthStore.getState().user as (Parameters<
        typeof setUserIfCurrent
      >[1] & { lastMoverRole?: string | null }) | null;
      if (!user || user.id !== owner.userId) throw new AuthSessionBoundaryError();
      const result = await unwrap<{
        roles?: string[];
        activeRole?: string;
        lastMoverRole?: 'DRIVER' | 'RIDER' | null;
      }>(partnerApi.become(data, owner));
      requireAuthSessionForPrincipal(owner);
      if (result.roles) {
        const canonical = canonicalMoverAuthority(
          result,
          result.activeRole ?? data.role,
          user.lastMoverRole,
        );
        if (!setUserIfCurrent(owner, {
          ...user,
          roles: result.roles,
          ...canonical,
        } as unknown as Parameters<typeof setUserIfCurrent>[1])) {
          throw new AuthSessionBoundaryError();
        }
      }
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['verification'] });
      void qc.invalidateQueries({ queryKey: ['vendor'] });
      void qc.invalidateQueries({ queryKey: ['mover'] });
      // Application in / store created — the earner's first obviously-useful
      // notification moment [first-open SO-5].
      maybePrimeNotifications(data.role === 'MOVER' ? 'driver_application' : 'store_created');
      return result;
    },
  });
}

/** Upload a single picked file to storage; resolves to its fileUrl. */
export function useUploadFile() {
  return useMutation({
    mutationFn: async (input: {
      uri: string;
      name: string;
      type: string;
      authSession?: AuthSessionSnapshot;
    }) => {
      const { authSession, ...file } = input;
      const owner = authSession ?? requireAuthSessionSnapshot();
      const current = requireAuthSessionForPrincipal(owner);
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
      const up = await unwrap<{ url: string }>(verificationApi.upload(form, current));
      requireAuthSessionForPrincipal(owner);
      return up.url;
    },
  });
}

/** Consumer L2: submit a government ID + selfie (manual KYC review). */
export function useSubmitIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { idDocumentUrl: string; selfieUrl: string }) => {
      const owner = requireAuthSessionSnapshot();
      const result = await unwrap(verificationApi.submitIdentity(
        { ...data, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION },
        owner,
      ));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['verification'] });
      return result;
    },
  });
}

/** Upload a picked file to storage, then submit it as a checklist document. */
export function useUploadDocument(role: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docType, file, authSession }: {
      docType: string;
      file: { uri: string; name: string; type: string };
      authSession?: AuthSessionSnapshot;
    }) => {
      const owner = authSession ?? requireAuthSessionSnapshot();
      const initial = requireAuthSessionForPrincipal(owner);
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
      const uploaded = await unwrap<{ url: string }>(verificationApi.upload(form, initial));
      const current = requireAuthSessionForPrincipal(owner);
      const result = await unwrap(
        verificationApi.submitDocument({
          role,
          docType,
          fileUrl: uploaded.url,
          consent: true,
          privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        }, current),
      );
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['verification', role] });
      return result;
    },
  });
}
