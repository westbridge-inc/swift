import { getSocket } from '../services/socket';
import { isSlowConnection } from './slowQueries';

/** Re-evaluated by React Query when scheduling each fallback poll.
 * Only for queries the server really pushes over the socket (an event this
 * client listens to invalidates the query): a connected socket then makes the
 * poll a safety net, so it may slow down. */
export function adaptivePollInterval(normal: number, reduced: number): number {
  return getSocket().connected || isSlowConnection() ? Math.max(normal, reduced) : normal;
}

/** For queries with NO socket push: a connected socket says nothing about
 * them, so only a slow network stretches the poll. */
export function slowNetworkPollInterval(normal: number, reduced: number): number {
  return isSlowConnection() ? Math.max(normal, reduced) : normal;
}
