import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { riderApi } from '../services/api';
import { useMoverPreview } from '../stores/moverPreview';
import { previewMutation } from '../lib/moverPreviewData';
import { evidenceFix } from './mover';
import { parseHolderCaseView, parseRelayTasks, type HolderCaseView, type RelayTask, type RiderProblemReason } from '../lib/custodyRecovery';
import { requireAuthSessionForPrincipal, requireAuthSessionSnapshot } from '../stores/authStore';

// [AF-MOB-006] Custody recovery for the rider: report a problem after pickup,
// see the case (and the handoff code), and — as a relay rider — take an order
// over with the holder's code. The server decides everything; these hooks only
// carry the rider's evidence (reason, GPS) and read back what it decided.

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

const holderKey = (orderId: string) => ['mover', 'custody', 'holder', orderId] as const;
const relayKey = ['mover', 'custody', 'relays'] as const;

/** The case on the holder's live job. A 404 is "no case", not an error. */
export function useHolderCase(orderId: string | undefined, enabled: boolean) {
  const pv = useMoverPreview((s) => s.preview);
  return useQuery<HolderCaseView | null>({
    queryKey: holderKey(orderId ?? ''),
    enabled: !!orderId && enabled && !pv,
    // Every 20 s while a case is open (its code can expire, its plan change);
    // otherwise once a minute, just to notice a case opened by operations.
    refetchInterval: (query) => (query.state.data ? 20_000 : 60_000),
    queryFn: async () => {
      try {
        return parseHolderCaseView(await unwrap(riderApi.recovery(orderId!)));
      } catch (error: any) {
        if (error?.response?.status === 404) return null;
        throw error;
      }
    },
  });
}

/** Report a problem after pickup: the reason plus the rider's location. */
export function useReportProblem() {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ orderId, reason, note }: { orderId: string; reason: RiderProblemReason; note?: string }) => {
      const owner = requireAuthSessionSnapshot();
      const fix = await evidenceFix(owner).catch(() => null);
      const session = requireAuthSessionForPrincipal(owner);
      const result = await unwrap(riderApi.reportProblem(orderId, { reason, ...(note ? { note } : {}), ...(fix ? { gps: fix.gps } : {}) }, session));
      void qc.invalidateQueries({ queryKey: holderKey(orderId) });
      return parseHolderCaseView(result);
    },
  });
  return pv ? previewMutation() : m;
}

/** The handoffs this rider has been asked to take over. */
export function useRelayTasks(enabled: boolean) {
  const pv = useMoverPreview((s) => s.preview);
  return useQuery<RelayTask[]>({
    queryKey: relayKey,
    enabled: enabled && !pv,
    refetchInterval: 30_000,
    queryFn: async () => parseRelayTasks(await unwrap(riderApi.relayTasks())),
  });
}

/** Take the order over with the holder's code. One key per attempt, so a retry
 *  after a lost answer replays it instead of spending a second try. */
export function useTransferCustody() {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ caseId, code, version, attemptKey }: { caseId: string; code: string; version: number; attemptKey: string }) => {
      const owner = requireAuthSessionSnapshot();
      const { gps, current } = await evidenceFix(owner);
      const result = await unwrap(riderApi.transferCustody(caseId, { code, gps, version }, attemptKey, current));
      requireAuthSessionForPrincipal(owner);
      void qc.invalidateQueries({ queryKey: relayKey });
      void qc.invalidateQueries({ queryKey: ['mover'] });
      return result;
    },
  });
  return pv ? previewMutation() : m;
}

/** Say no to a relay; operations is told and names someone else. */
export function useDeclineRelay() {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ caseId, reason }: { caseId: string; reason?: string }) => {
      const result = await unwrap(riderApi.declineRelay(caseId, reason));
      void qc.invalidateQueries({ queryKey: relayKey });
      return result;
    },
  });
  return pv ? previewMutation() : m;
}
