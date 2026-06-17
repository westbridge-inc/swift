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
