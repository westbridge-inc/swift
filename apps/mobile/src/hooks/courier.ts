import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { courierApi } from '../services/api';

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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, uri }: { orderId: string; uri: string }) => {
      const form = new FormData();
      form.append('file', { uri, name: 'proof.jpg', type: 'image/jpeg' } as unknown as Blob);
      const up = await courierApi.uploadProof(orderId, form);
      const url = (up as any)?.data?.data?.url as string;
      if (!url) throw new Error('upload failed');
      return unwrap(courierApi.proof(orderId, url));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['courier', 'orders'] });
      qc.invalidateQueries({ queryKey: ['mover'] });
    },
  });
}
