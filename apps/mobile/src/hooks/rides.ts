import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rideApi } from '../services/api';

type Point = { lat: number; lng: number };

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

export function useActiveRide<T = any>(poll = false) {
  return useQuery<T>({
    queryKey: ['rides', 'active'],
    queryFn: () => unwrap<T>(rideApi.active()),
    refetchInterval: poll ? 8000 : undefined,
  });
}

export function useRideEstimate<T = any>(pickup?: Point, dropoff?: Point) {
  return useQuery<T>({
    queryKey: ['rides', 'estimate', pickup, dropoff],
    queryFn: () => unwrap<T>(rideApi.estimate(pickup as Point, dropoff as Point)),
    enabled: !!pickup && !!dropoff,
  });
}

export function useRequestRide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      pickup: Point;
      dropoff: Point;
      pickupAddress: string;
      dropoffAddress: string;
      passengerCount?: number;
      rideClass?: 'STANDARD' | 'COMFORT' | 'XL';
    }) => unwrap(rideApi.request(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rides', 'active'] }),
  });
}

export function useCancelRide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => unwrap(rideApi.cancel(id, reason)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rides', 'active'] }),
  });
}
