import { getSocket } from '../services/socket';
import { isSlowConnection } from './slowQueries';

/** Re-evaluated by React Query when scheduling each fallback poll. */
export function adaptivePollInterval(normal: number, reduced: number): number {
  return getSocket().connected || isSlowConnection() ? Math.max(normal, reduced) : normal;
}
