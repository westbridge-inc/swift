import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { verificationApi, partnerApi, type VehicleKind } from '../services/api';
import { maybePrimeNotifications } from '../services/notification-priming';
import { useMoverPreview } from '../stores/moverPreview';
import { useBusinessSetupDraft } from '../stores/businessSetupDraft';
import { PREVIEW_VERIFICATION, previewQuery } from '../lib/moverPreviewData';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../stores/authStore';
import { canonicalMoverAuthority } from '../lib/moverAuthorityCache';
import type { AuthSessionSnapshot } from '../lib/authSession';
import { verificationRefetchInterval } from './verificationPolling';
import type { MutationGuard } from './useStepUp';

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
      ? (query) => verificationRefetchInterval(query.state.data as { roleVerified?: boolean; categoryUnavailable?: boolean } | undefined)
      : undefined,
  });
  return previewMover ? previewQuery(PREVIEW_VERIFICATION) : q;
}

/** Public weekly price list for the partner pitch ("N days free, then X/week"). */
export { usePartnerPricing } from './partnerPricing';

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
      // The store exists: its List-your-business draft is done. Cleared here,
      // not by the screen — a per-call observer callback never runs once the
      // screen has unmounted — and only for the account that submitted it.
      if (data.role === 'VENDOR') useBusinessSetupDraft.getState().clearIfOwner(owner);
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

/**
 * [VEHICLES] Change the vehicle a mover works with (PUT /partner/vehicle). The server
 * takes the mover offline, retires the papers about the old vehicle and may move them
 * between delivery and taxi work, so the session's roles and mover pointer are
 * re-read from its answer exactly as "Save vehicle" does. `guard` is the step-up
 * wrapper (hooks/useStepUp): a verified mover confirms it is them first.
 */
export function useChangeVehicle(guard?: MutationGuard) {
  const qc = useQueryClient();
  const setUserIfCurrent = useAuthStore((s) => s.setUserIfCurrent);
  const run = async (data: {
    vehicleType: VehicleKind;
    vehicle?: { make: string; model: string; year: number; color: string; licensePlate: string };
  }) => {
    const owner = requireAuthSessionSnapshot();
    const user = useAuthStore.getState().user as (Parameters<
      typeof setUserIfCurrent
    >[1] & { lastMoverRole?: string | null; roles?: string[] }) | null;
    if (!user || user.id !== owner.userId) throw new AuthSessionBoundaryError();
    const result = await unwrap<{
      kind: 'RIDER' | 'DRIVER';
      vehicleType: VehicleKind;
      changed: boolean;
      activeRole?: string | null;
      lastMoverRole?: 'DRIVER' | 'RIDER' | null;
    }>(partnerApi.changeVehicle(data, owner));
    requireAuthSessionForPrincipal(owner);
    if (result.changed && result.activeRole) {
      // A move between delivery and taxi work adds that role; the pointer follows the server.
      const roles = Array.from(new Set([...(user.roles ?? []), 'MOVER', result.kind]));
      const canonical = canonicalMoverAuthority(
        { roles, activeRole: result.activeRole, lastMoverRole: result.lastMoverRole ?? null },
        result.activeRole,
        user.lastMoverRole,
      );
      if (!setUserIfCurrent(owner, { ...user, roles, ...canonical } as unknown as Parameters<typeof setUserIfCurrent>[1])) {
        throw new AuthSessionBoundaryError();
      }
    }
    void qc.invalidateQueries({ queryKey: ['verification'] });
    void qc.invalidateQueries({ queryKey: ['mover'] });
    return result;
  };
  return useMutation({ mutationFn: guard ? guard(run) : run });
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
