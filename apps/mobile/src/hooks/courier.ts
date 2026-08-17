import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { courierApi } from '../services/api';
import { useMoverPreview } from '../stores/moverPreview';
import { previewMutation } from '../lib/moverPreviewData';
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

/** Proof of delivery (D8-02): upload the captured photo, then confirm the
 *  handoff with the returned url. One mutation, two server calls. */
export function useCourierProof() {
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
      form.append('file', { uri, name: 'proof.jpg', type: 'image/jpeg' } as unknown as Blob);
      const up = await courierApi.uploadProof(orderId, form, initial);
      const current = requireAuthSessionForPrincipal(owner);
      const url = (up as any)?.data?.data?.url as string;
      if (!url) throw new Error('upload failed');
      const result = await unwrap(courierApi.proof(orderId, url, current));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: ['courier', 'orders'] });
      void qc.invalidateQueries({ queryKey: ['mover'] });
      return result;
    },
  });
  return pv ? previewMutation() : m;
}
