import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
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
