import { prepareUploadImage } from '../lib/uploadImage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { courierApi } from '../services/api';
import { courierRequestAttempt } from '../lib/courierRequestAttemptStore';
import { useMoverPreview } from '../stores/moverPreview';
import { previewMutation } from '../lib/moverPreviewData';
import { evidenceFix } from './mover';
import type { AuthSessionSnapshot } from '../lib/authSession';
import {
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../stores/authStore';

type Point = { lat: number; lng: number };
type Size = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
type Speed = 'STANDARD' | 'EXPRESS' | 'RUSH';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

export function useCourierEstimate<T = any>(pickup?: Point, dropoff?: Point, packageSize: Size = 'MEDIUM', speed: Speed = 'STANDARD') {
  return useQuery<T>({
    queryKey: ['courier', 'estimate', pickup, dropoff, packageSize, speed],
    queryFn: () => unwrap<T>(courierApi.estimate({ pickup: pickup as Point, dropoff: dropoff as Point, packageSize, speed })),
    enabled: !!pickup && !!dropoff,
  });
}

export function useCourierOrders<T = any>() {
  return useQuery<T>({ queryKey: ['courier', 'orders'], queryFn: () => unwrap<T>(courierApi.orders()) });
}

/**
 * [UI-SWEEP U01] The courier route's refusals that are checked BEFORE anything
 * is written: only these (and a parcel) retire the intent's key. Anything else
 * keeps it — a 5xx, a timeout or a lost answer may hide a parcel already made,
 * and the same key makes the retry replay that parcel instead of booking again.
 */
const COURIER_REFUSED_WROTE_NOTHING = new Set([
  'VALIDATION_ERROR', 'PARCEL_TOO_BIG', 'ACCOUNT_RESTRICTED', 'PROHIBITED_PARCEL', 'PRICE_CHANGED',
  'IDEMPOTENCY_MISMATCH', 'INVALID_IDEMPOTENCY_KEY',
]);

function courierRefusedWroteNothing(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: { error?: { code?: unknown } } } } | null)?.response;
  const code = response?.data?.error?.code;
  return typeof response?.status === 'number' && response.status >= 400 && response.status < 500
    && typeof code === 'string' && COURIER_REFUSED_WROTE_NOTHING.has(code);
}

export function useSendCourier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: any) => {
      // The account that tapped Send: a switch since the tap sends nothing.
      const owner = requireAuthSessionSnapshot();
      const current = requireAuthSessionForPrincipal(owner);
      // One synchronous step: two taps on the same parcel share one key.
      const key = courierRequestAttempt.begin(data, owner.userId);
      try {
        const answer = await unwrap(courierApi.order(data, key, current));
        courierRequestAttempt.settle(key, owner.userId);
        return answer;
      } catch (error) {
        if (courierRefusedWroteNothing(error)) courierRequestAttempt.settle(key, owner.userId);
        throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['courier', 'orders'] }),
  });
}

/** [M-28] The cash outcome a courier job closes on. 'paid' captures the fee
 *  and delivers in one commit; 'refused' / 'no_show' fail the job with the
 *  proof photo and the rider's location as the claim's evidence. */
export type CourierCashOutcome = 'paid' | 'no_show' | 'refused';

/** Proof of delivery (D8-02): upload the captured photo, then confirm the
 *  handoff with the returned url. One mutation, two server calls.
 *
 *  [M-28] When the RECIPIENT pays a cash job, the outcome travels WITH the
 *  proof on the rider's evidence fix — the server refuses a bare proof on an
 *  unpaid cash job, because a proof never implies money. A job already paid
 *  (MMG, or the sender's fee collected at pickup) sends the photo alone. The
 *  outcome is the caller's, never defaulted here. */
export function useCourierProof() {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ orderId, uri, outcome, authSession }: {
      orderId: string;
      uri: string;
      outcome?: CourierCashOutcome;
      authSession?: AuthSessionSnapshot;
    }) => {
      const owner = authSession ?? requireAuthSessionSnapshot();
      const initial = requireAuthSessionForPrincipal(owner);
      const form = new FormData();
      form.append('file', await prepareUploadImage({ uri, name: 'proof.jpg', type: 'image/jpeg' }) as unknown as Blob);
      requireAuthSessionForPrincipal(owner);
      const up = await courierApi.uploadProof(orderId, form, initial);
      let current = requireAuthSessionForPrincipal(owner);
      const url = (up as any)?.data?.data?.url as string;
      if (!url) throw new Error('upload failed');
      let body: { proofPhotoUrl: string; outcome?: CourierCashOutcome; gps?: { lat: number; lng: number } } = { proofPhotoUrl: url };
      if (outcome) {
        const fix = await evidenceFix(owner);
        current = fix.current;
        body = { proofPhotoUrl: url, outcome, gps: fix.gps };
      }
      const result = await unwrap(courierApi.proof(orderId, body, current));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['courier', 'orders'] });
      void qc.invalidateQueries({ queryKey: ['mover'] });
      return result;
    },
  });
  return pv ? previewMutation() : m;
}

/** [M-28] The SENDER pays: the fee is collected at pickup, before custody.
 *  'paid' captures it (the proof at the door then closes the job); 'refused'
 *  ends the job there with a strike on the sender. The rider's evidence fix
 *  travels with either — it is what the record stands on. */
export function useCourierCollect() {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ orderId, outcome }: { orderId: string; outcome: 'paid' | 'refused' }) => {
      const owner = requireAuthSessionSnapshot();
      const { gps, current } = await evidenceFix(owner);
      const result = await unwrap(courierApi.collect(orderId, { outcome, gps }, current));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['courier', 'orders'] });
      void qc.invalidateQueries({ queryKey: ['mover'] });
      return result;
    },
  });
  return pv ? previewMutation() : m;
}

/** [E17] The mover can't deliver after custody: the reason + the rider's
 *  evidence fix start a support-visible return and notify the sender. The
 *  server refuses unless the parcel is in THIS rider's custody. */
export function useCourierReturn() {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ orderId, reason }: { orderId: string; reason: string }) => {
      const owner = requireAuthSessionSnapshot();
      const { gps, current } = await evidenceFix(owner);
      const result = await unwrap(courierApi.return(orderId, { reason, gps }, current));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['courier', 'orders'] });
      void qc.invalidateQueries({ queryKey: ['mover'] });
      return result;
    },
  });
  return pv ? previewMutation() : m;
}

/** [E17] The return photo closes the return leg: capture → upload with the
 *  rider's location (the multipart lat/lng the server requires) → RETURNED,
 *  which releases the rider. The sender is notified server-side. */
export function useCourierReturnProof() {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ orderId, uri, authSession }: {
      orderId: string;
      uri: string;
      authSession?: AuthSessionSnapshot;
    }) => {
      const owner = authSession ?? requireAuthSessionSnapshot();
      const { gps, current } = await evidenceFix(owner);
      const form = new FormData();
      // [DS202 D1] The location travels BEFORE the photo (the server now reads
      // every part in any order, and fields first is the safe order for any
      // multipart reader).
      form.append('lat', String(gps.lat));
      form.append('lng', String(gps.lng));
      form.append('file', await prepareUploadImage({ uri, name: 'return-proof.jpg', type: 'image/jpeg' }) as unknown as Blob);
      requireAuthSessionForPrincipal(owner);
      const result = await unwrap(courierApi.returnProof(orderId, form, current));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['courier', 'orders'] });
      void qc.invalidateQueries({ queryKey: ['mover'] });
      return result;
    },
  });
  return pv ? previewMutation() : m;
}

/** E16: pickup custody proof. PICKED_UP is a physical-custody claim, so the
 *  bare tap is refused server-side and the pickup must carry a photo + the
 *  rider's location. One mutation, two server calls: upload the captured
 *  photo, then confirm pickup with the returned URL on the evidence fix —
 *  GPS is ALWAYS present here, the server will not accept the proof without it. */
export function useCourierPickupProof() {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ orderId, uri, authSession }: {
      orderId: string;
      uri: string;
      authSession?: AuthSessionSnapshot;
    }) => {
      const owner = authSession ?? requireAuthSessionSnapshot();
      const initial = requireAuthSessionForPrincipal(owner);
      const form = new FormData();
      form.append('file', await prepareUploadImage({ uri, name: 'pickup-proof.jpg', type: 'image/jpeg' }) as unknown as Blob);
      requireAuthSessionForPrincipal(owner);
      const up = await courierApi.uploadPickupProof(orderId, form, initial);
      requireAuthSessionForPrincipal(owner);
      const url = (up as any)?.data?.data?.url as string;
      if (!url) throw new Error('upload failed');
      const fix = await evidenceFix(owner);
      const result = await unwrap(courierApi.pickupProof(orderId, { proofPhotoUrl: url, gps: fix.gps }, fix.current));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['courier', 'orders'] });
      void qc.invalidateQueries({ queryKey: ['mover'] });
      return result;
    },
  });
  return pv ? previewMutation() : m;
}
