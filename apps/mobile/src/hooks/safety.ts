import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { track } from '../lib/analytics';
import { safetyApi } from '../services/api';
import { createSosKeyStore } from '../lib/sosKey';

/**
 * Emergency alert on any job that is not a taxi ride.
 *
 * The safety engine was built complete and then never called: `POST
 * /safety/sos` authorises the customer, the driver OR the rider on an order,
 * lifts the rate limit so a panicking person is never met with a 429, and
 * collapses repeats by idempotency key — and no surface in the product ever
 * invoked it. Taxi had its own `/rides/:id/sos`, so taxi had a button and
 * everyone else had nothing.
 */
export function useJobSos() {
  // A ref, not state: a re-render must never hand the same emergency a new
  // identity, which is exactly what a fresh store would do.
  const keys = useRef(createSosKeyStore()).current;

  return useMutation({
    mutationFn: ({
      jobId,
      coords,
    }: {
      jobId: string;
      coords?: { lat: number; lng: number; accuracyM?: number };
    }) =>
      safetyApi.sos({
        orderId: jobId,
        lat: coords?.lat,
        lng: coords?.lng,
        accuracyM: coords?.accuracyM,
        clientIdempotencyKey: keys.keyFor(jobId),
      }),
    onSuccess: () => track('job_sos', {}),
  });
}

/**
 * [B3] Emergency alert on a SERVICE job — the last two uncovered surfaces:
 * a hired professional working in a stranger's home, and the customer whose
 * home they are in. A ServiceJob is not an order, so it rides its own SOS
 * context (`serviceJobId`); the server authorises exactly the job's customer
 * and its provider, and repeats collapse per job like they do per order.
 */
export function useServiceJobSos() {
  const keys = useRef(createSosKeyStore()).current;

  return useMutation({
    mutationFn: ({
      serviceJobId,
      coords,
    }: {
      serviceJobId: string;
      coords?: { lat: number; lng: number; accuracyM?: number };
    }) =>
      safetyApi.sos({
        serviceJobId,
        lat: coords?.lat,
        lng: coords?.lng,
        accuracyM: coords?.accuracyM,
        clientIdempotencyKey: keys.keyFor(serviceJobId),
      }),
    onSuccess: () => track('service_job_sos', {}),
  });
}

// ---------------------------------------------------------------------------
// EMERGENCY CONTACTS [S15]
//
// The same shape of gap as the SOS button itself, one step further along the
// chain. `sos.service.ts` SMSes VERIFIED emergency contacts when an alert goes
// active — and no screen in the app could ever add one, so that query returned
// an empty list for every user and the fan-out reached nobody. The button was
// wired; the people it exists to reach were not.
// ---------------------------------------------------------------------------

export const emergencyContactKeys = { all: ['safety', 'emergency-contacts'] as const };

export interface EmergencyContact {
  id: string;
  name: string;
  phoneE164: string;
  relationship?: string | null;
  priority: number;
  verifiedAt: string | null;
}

export function useEmergencyContacts() {
  return useQuery<EmergencyContact[]>({
    queryKey: emergencyContactKeys.all,
    queryFn: async () => {
      const res = await safetyApi.listEmergencyContacts();
      return (res.data?.data ?? []) as EmergencyContact[];
    },
  });
}

/** Every write refetches the list — a contact's VERIFIED state is the whole
 *  point of the screen, and a stale badge would claim someone will be alerted
 *  in an emergency when they will not. */
function useContactMutation<TArg, TRes>(fn: (arg: TArg) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: emergencyContactKeys.all }),
  });
}

export function useAddEmergencyContact() {
  return useContactMutation((data: { name: string; phoneE164: string; relationship?: string; priority?: number }) =>
    safetyApi.addEmergencyContact(data).then((r) => r.data?.data as { id: string; codeSent: boolean }));
}

export function useVerifyEmergencyContact() {
  return useContactMutation(({ id, code }: { id: string; code: string }) =>
    safetyApi.verifyEmergencyContact(id, code));
}

export function useResendEmergencyContactCode() {
  return useContactMutation((id: string) => safetyApi.resendEmergencyContactCode(id));
}

export function useRemoveEmergencyContact() {
  return useContactMutation((id: string) => safetyApi.removeEmergencyContact(id));
}

export interface LivenessCheckOutcome {
  checkId: string;
  outcome: 'PASS' | 'BORDERLINE' | 'FAIL' | 'ERROR_FAIL_OPEN' | 'ERROR_FAIL_CLOSED';
  allowedOnline: boolean;
  attemptsLeft?: number;
}

/** §7.1 — run one shift identity check. The screen renders every outcome
 *  itself (including the 423 lock), so the global error toast stays out. */
export function useLivenessCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ photoUri, profile }: { photoUri: string; profile: 'DRIVER' | 'RIDER' }) => {
      const form = new FormData();
      form.append('file', { uri: photoUri, name: 'liveness.jpg', type: 'image/jpeg' } as never);
      const res = await safetyApi.livenessCheck(form, profile);
      return res.data?.data as LivenessCheckOutcome;
    },
    // A pass changes what go-online will say — refetch the mover surface.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover'] }),
    meta: { silent: true },
  });
}
