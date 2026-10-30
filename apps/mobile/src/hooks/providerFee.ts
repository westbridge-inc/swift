import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { providerFeeApi } from '../services/api';
import { requireAuthSessionForPrincipal, requireAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import type { ProFeeView } from '../lib/providerFee';

/** [BILL-PRO PR5] The pro's own weekly fee (GET /provider/subscription): the whole body, so the screen sees where the
 *  pro stands and the words to tick as well as the fee. */
export function useProviderFee() {
  const userId = useAuthStore((state) => state.user?.id);
  return useQuery<ProFeeView>({
    queryKey: ['provider', 'fee', userId],
    queryFn: async () => {
      const owner = requireAuthSessionSnapshot();
      const response = await providerFeeApi.subscription(owner);
      requireAuthSessionForPrincipal(owner);
      const body = response?.data ?? {};
      return { data: body.data ?? null, standing: body.standing, coveredBy: body.coveredBy ?? null, feeTerms: body.feeTerms };
    },
    enabled: !!userId,
  });
}

/** "I understand the weekly fee", as a pro: the words' version and the amount on screen. */
export function useAcknowledgeProviderFee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ack: { version: string; amount: number; currencyCode: string }) => {
      const owner = requireAuthSessionSnapshot();
      const response = await providerFeeApi.acknowledge(ack, owner);
      requireAuthSessionForPrincipal(owner);
      return response?.data?.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['provider', 'fee'] });
      void qc.invalidateQueries({ queryKey: ['services', 'provider-me'] });
    },
  });
}
