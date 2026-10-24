import { apiFetch } from '@/lib/auth';

/**
 * [STORE-DASH · O-2] The store handed the order to the Swift rider: one status-log row; custody
 * stays the rider's "Picked up". Its own small file, loaded by the orders screens only, so every
 * dashboard page that reads the store API does not carry it.
 */
export const handedToRider = (id: string) => apiFetch(`/api/v1/vendor/orders/${id}/handed-to-rider`, { method: 'PUT', body: '{}' });
