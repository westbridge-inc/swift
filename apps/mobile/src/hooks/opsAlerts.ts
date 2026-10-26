import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { safetyApi } from '../services/api';
import type { OpsAlertRow } from '../lib/opsAlerts';

// [DRILL-STORM · S-19] A responder's pages on the phone: the open pages the
// server lets this account see, and the acknowledgement. Nothing is decided
// here — the server says who may list and acknowledge (the admin role the
// account holds, never the app's mode) and which alerts they reach.

export const OPS_ALERTS_KEY = ['safety', 'ops-alerts'] as const;

export function useOpsAlerts() {
  return useQuery({
    queryKey: OPS_ALERTS_KEY,
    queryFn: async () => ((await safetyApi.opsAlerts()).data?.data ?? []) as OpsAlertRow[],
    refetchInterval: 15_000,
    // A refusal (not a responder) is an answer, not a blip: never retried into a spinner.
    retry: false,
  });
}

export function useAcknowledgeOpsAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => ((await safetyApi.acknowledgeOpsAlert(id)).data?.data ?? { acknowledged: false }) as { acknowledged: boolean },
    onSettled: () => { void qc.invalidateQueries({ queryKey: OPS_ALERTS_KEY }); },
    // The screen says what happened, in its own words.
    meta: { silent: true },
  });
}
