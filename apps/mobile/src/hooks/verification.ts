import { prepareUploadImage } from '../lib/uploadImage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { verificationApi, partnerApi, vendorApi, type UploadConsentVia, type VehicleKind } from '../services/api';
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
import type { WeeklyFeeAck } from '../lib/partnerPricing';

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
      /** [Row 628] The "I understand the weekly fee" tick: the words' version and the fee on screen. */
      weeklyFeeAck?: WeeklyFeeAck;
      business?: {
        name: string;
        vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
        phone: string;
        addressLine1: string;
        city: string;
        region?: string;
        /** [ROLE-DOCS · owner 21 Oct 2026] the store trades under its owner's own name (checked by the server) */
        nameBasis?: 'OWN_NAME' | 'REGISTERED';
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
      // [ROLE-DOCS · owner 21 Oct 2026] The owner ticked the own-name declaration before the store existed: it is
      // signed now, in the same turn as the session check above, so it is this account's. Here, not on the screen:
      // the store's creation swaps the navigator, and a callback on an unmounted screen never runs. A failure never
      // fails the store; its Documents checklist offers the same signature again.
      if (data.role === 'VENDOR' && data.business?.nameBasis === 'OWN_NAME') {
        let signing: Promise<unknown>;
        try { signing = Promise.resolve(vendorApi.signOwnName()); } catch { signing = Promise.resolve(); }
        await signing.catch(() => undefined);
      }
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
      form.append('file', await prepareUploadImage(file, true) as any);
      requireAuthSessionForPrincipal(owner);
      const up = await unwrap<{ url: string }>(verificationApi.upload(form, current));
      requireAuthSessionForPrincipal(owner);
      return up.url;
    },
  });
}

/** Consumer L2: submit a government ID. [Owner ruling 8 Oct 2026] It goes on file at once unless the
 *  server's automatic checks hold it for a person; no selfie, no face match. The result carries
 *  `idCheck` (ON_FILE · WAITING · NOT_ACCEPTED) — read it through lib/customerIdCopy. */
export function useSubmitIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { idDocumentUrl: string }) => {
      const owner = requireAuthSessionSnapshot();
      const result = await unwrap(verificationApi.submitIdentity(
        // [R17 · in-app ¶15] the screen's tick is recorded in the consent ledger. [Owner ruling 24 Oct 2026]
        // v2 = the words that promise no unlock (the API accepts v1 from build 12's own JS as well).
        { ...data, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION, consentTick: 'customer_id_v2' },
        owner,
      ));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['verification'] });
      // The Profile row reads the new idCheck from /customer/profile.
      void qc.invalidateQueries({ queryKey: ['customer', 'profile'] });
      return result;
    },
  });
}

/** Upload a picked file to storage, then submit it as a checklist document. */
export function useUploadDocument(role: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docType, file, authSession, consentVia, consent }: {
      docType: string;
      file: { uri: string; name: string; type: string };
      authSession?: AuthSessionSnapshot;
      /** [DOC-CONSENT S4] how the checklist's tick was given for this upload (the ledger records it). */
      consentVia?: UploadConsentVia;
      /** [POLICE-CLEARANCE CONSENT] a police clearance's own tick and the version of the words shown. */
      consent?: { tick: 'police_clearance_v1'; version: string };
    }) => {
      const owner = authSession ?? requireAuthSessionSnapshot();
      const initial = requireAuthSessionForPrincipal(owner);
      const form = new FormData();
      form.append('file', await prepareUploadImage(file, true) as any);
      requireAuthSessionForPrincipal(owner);
      const uploaded = await unwrap<{ url: string }>(verificationApi.upload(form, initial));
      const current = requireAuthSessionForPrincipal(owner);
      const result = await unwrap(
        verificationApi.submitDocument({
          role,
          docType,
          fileUrl: uploaded.url,
          consent: true,
          privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
          // [R17] the checklist's tick (build 12) is recorded in the consent ledger; a police clearance sends its own
          ...(consent ? { consentTick: consent.tick, consentVersion: consent.version } : { consentTick: 'document_v1' }),
          ...(consentVia ? { consentVia } : {}),
        }, current),
      );
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['verification', role] });
      return result;
    },
    // [DOC-CONSENT S4 · REVIEW-F] A consent the API refused — no longer on record (withdrawn meanwhile), or words that
    // changed — re-reads the checklist, so the box shows the truth instead of a tick that no longer stands.
    onError: (error) => {
      const code = (error as { response?: { data?: { error?: { code?: string } } } } | null)?.response?.data?.error?.code;
      if (code === 'CONSENT_NOT_ON_RECORD' || code === 'CONSENT_WORDS_CHANGED') void qc.invalidateQueries({ queryKey: ['verification', role] });
    },
  });
}

/**
 * [POLICE-CLEARANCE CONSENT] Withdraw this checklist's police clearance (POST /verification/police-clearance/withdraw):
 * the API erases it now, keeps only a note, and records the withdrawal; the checklist refreshes.
 */
export function useWithdrawPoliceClearance(role: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const owner = requireAuthSessionSnapshot();
      const result = await unwrap<{ withdrawn: number; kept: number }>(verificationApi.withdrawPoliceClearance(role, owner));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['verification', role] });
      return result;
    },
  });
}
