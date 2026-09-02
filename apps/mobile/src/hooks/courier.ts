import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { courierApi } from '../services/api';
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

export function useSendCourier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => unwrap(courierApi.order(data)),
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
      form.append('file', { uri, name: 'proof.jpg', type: 'image/jpeg' } as unknown as Blob);
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
