import { apiFetch } from './auth';

export type WebRole = 'CUSTOMER' | 'VENDOR' | 'MOVER' | 'DRIVER' | 'RIDER';
export const switchWebRole = (role: WebRole): Promise<{ activeRole: string; lastMoverRole?: string }> =>
  apiFetch('/api/v1/customer/switch-role', { method: 'POST', body: JSON.stringify({ role }) }).then(r => r.data);

export interface Advertiser { id: string; companyName: string; status: string; memberRole: string }
export interface Campaign {
  id: string; name: string; status: string; statusReason: string | null;
  placement: { name: string; key: string; tier: string; mediaKind: string };
  cities: string[]; startWeek: string; endWeek: string; totalAmount: number | null; currency: string;
  invoices: { id: string; number: string; status: string; amount: number }[];
  creatives: { id: string; status: string; transcodeStatus: string | null }[];
  bookings: { weekStart: string; city: string; status: string }[];
}
export const getAdvertisers = (): Promise<Advertiser[]> => apiFetch('/api/v1/ads/advertiser/me').then(r => r.data);
export const getCampaigns = (advertiserId: string): Promise<Campaign[]> =>
  apiFetch(`/api/v1/ads/advertiser/${encodeURIComponent(advertiserId)}/campaigns`).then(r => r.data);
export interface Notice { id: string; title: string; body: string; isRead: boolean; createdAt: string }
export async function getNotifications(page = 1): Promise<{ rows: Notice[]; total: number }> {
  const r = await apiFetch(`/api/v1/customer/notifications?page=${page}&limit=20`);
  return { rows: r.data, total: r.meta?.total ?? r.data.length };
}
