import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { connectSocket, getSocket } from '../services/socket';
import { bindMoverJobFeed } from '../lib/moverJobFeed';
import { useMoverPreview } from '../stores/moverPreview';
import { activeLegsQueryFn, useActiveJob, type MoverKind } from './mover';

/** The order ids of a mover's live jobs: the active job plus a stacked
 *  rider's other legs, sorted and joined so an effect re-binds only when the
 *  set changes. */
export function liveJobIdsKey(primary: unknown, legs: unknown): string {
  const ids = new Set<string>();
  const add = (job: unknown) => {
    const id = (job as { id?: unknown } | null | undefined)?.id;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  };
  add(primary);
  const list = (legs as { legs?: unknown } | null | undefined)?.legs;
  if (Array.isArray(list)) list.forEach(add);
  return [...ids].sort().join(',');
}

/**
 * [PERF partner #1] A driver's or rider's live job changes on screen the
 * moment the server says so (lib/moverJobFeed). Mounted once, above the
 * mover's screens, beside the location supervisor, so it holds while any of
 * them is open. It reads the jobs the screens already poll and never fetches
 * by itself: the legs observer is disabled, so a rider who is not on Home or a
 * job screen gets no extra polling. An event re-reads only the active job, and
 * never cancels a read already in flight (a step's own refresh owns that).
 */
export function useMoverJobFeed(kind: MoverKind | null) {
  const pv = useMoverPreview((s) => s.preview);
  const qc = useQueryClient();
  const primary = useActiveJob(kind);
  const legs = useQuery({
    queryKey: ['mover', 'active', kind, 'legs'],
    queryFn: activeLegsQueryFn,
    enabled: false,
  });
  const key = liveJobIdsKey(primary.data, kind === 'RIDER' ? legs.data : null);
  useEffect(() => {
    if (!kind || pv || !key) return;
    connectSocket();
    return bindMoverJobFeed(getSocket(), key.split(','), () =>
      qc.invalidateQueries({ queryKey: ['mover', 'active', kind] }, { cancelRefetch: false }));
  }, [kind, pv, key, qc]);
}
