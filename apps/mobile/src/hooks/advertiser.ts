import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adsApi } from '../services/api';

/**
 * Advertiser dashboard hooks (ads spec §14). Same conventions as the vendor
 * hooks: react-query over the api client, `{ success, data }` unwrapped here.
 */
async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const res = await p;
  return res?.data?.data as T;
}

export const advertiserKeys = {
  me: ['ads', 'advertiser', 'me'] as const,
  campaigns: (id: string) => ['ads', 'advertiser', id, 'campaigns'] as const,
  invoices: (id: string) => ['ads', 'advertiser', id, 'invoices'] as const,
  members: (id: string) => ['ads', 'advertiser', id, 'members'] as const,
  placements: ['ads', 'placements'] as const,
  availability: (placementId: string, city: string, from: string, to: string) =>
    ['ads', 'availability', placementId, city, from, to] as const,
  stats: (campaignId: string) => ['ads', 'campaign', campaignId, 'stats'] as const,
};

export function useMyAdvertisers() {
  return useQuery({ queryKey: advertiserKeys.me, queryFn: () => unwrap<any[]>(adsApi.me()) });
}

export function useAdvertiserCampaigns(advertiserId: string | undefined) {
  return useQuery({
    queryKey: advertiserKeys.campaigns(advertiserId ?? ''),
    queryFn: () => unwrap<any[]>(adsApi.campaigns(advertiserId!)),
    enabled: !!advertiserId,
  });
}

export function useAdvertiserInvoices(advertiserId: string | undefined) {
  return useQuery({
    queryKey: advertiserKeys.invoices(advertiserId ?? ''),
    queryFn: () => unwrap<any[]>(adsApi.invoices(advertiserId!)),
    enabled: !!advertiserId,
  });
}

export function useAdvertiserMembers(advertiserId: string | undefined) {
  return useQuery({
    queryKey: advertiserKeys.members(advertiserId ?? ''),
    queryFn: () => unwrap<any[]>(adsApi.members(advertiserId!)),
    enabled: !!advertiserId,
  });
}

export function useAdPlacements() {
  return useQuery({ queryKey: advertiserKeys.placements, queryFn: () => unwrap<any[]>(adsApi.placements()) });
}

export function useAdAvailability(placementId: string | undefined, city: string, from: string, to: string) {
  return useQuery({
    queryKey: advertiserKeys.availability(placementId ?? '', city, from, to),
    queryFn: () => unwrap<any>(adsApi.availability(placementId!, { city, from, to })),
    enabled: !!placementId,
  });
}

export function useCampaignStats(campaignId: string | undefined) {
  return useQuery({
    queryKey: advertiserKeys.stats(campaignId ?? ''),
    queryFn: () => unwrap<any>(adsApi.stats(campaignId!)),
    enabled: !!campaignId,
  });
}

export function useRegisterAdvertiser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof adsApi.register>[0]) => unwrap<any>(adsApi.register(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: advertiserKeys.me }),
  });
}

export function useAdvertiserActions(advertiserId: string | undefined) {
  const qc = useQueryClient();
  const invalidate = () => {
    if (advertiserId) {
      void qc.invalidateQueries({ queryKey: advertiserKeys.campaigns(advertiserId) });
      void qc.invalidateQueries({ queryKey: advertiserKeys.invoices(advertiserId) });
    }
  };
  return {
    createCampaign: useMutation({ mutationFn: (d: Parameters<typeof adsApi.createCampaign>[0]) => unwrap<any>(adsApi.createCampaign(d)), onSuccess: invalidate }),
    reserve: useMutation({ mutationFn: (id: string) => unwrap<any>(adsApi.reserve(id)), onSuccess: invalidate }),
    checkout: useMutation({ mutationFn: (id: string) => unwrap<any>(adsApi.checkout(id)), onSuccess: invalidate }),
    pause: useMutation({ mutationFn: (id: string) => unwrap<any>(adsApi.pause(id)), onSuccess: invalidate }),
    resume: useMutation({ mutationFn: (id: string) => unwrap<any>(adsApi.resume(id)), onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: (id: string) => unwrap<any>(adsApi.cancel(id)), onSuccess: invalidate }),
    addMember: useMutation({
      mutationFn: (d: { phone: string; role: 'MANAGER' | 'ANALYST' }) => unwrap<any>(adsApi.addMember(advertiserId!, d)),
      onSuccess: () => advertiserId && void qc.invalidateQueries({ queryKey: advertiserKeys.members(advertiserId) }),
    }),
  };
}
