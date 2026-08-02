// The client ride state machine [rides spec Part 4] — a PURE mirror of the
// server's order lifecycle. The server owns every decision (cancel grace,
// queue position, code verification); this reducer only names what the UI
// should show and never computes eligibility from its own clock. Unknown
// event for the current state → SELF_HEAL (refetch /rides/active), never a
// crash [Part 4 hard rules]. Server truth arriving by fetch or socket always
// wins over the local guess.

export type RideUiState =
  | 'IDLE'
  | 'DEST_ENTRY'
  | 'ROUTE_PREVIEW'
  | 'REQUESTING'
  | 'MATCHED'
  | 'DRIVER_EN_ROUTE'
  | 'DRIVER_ARRIVED'
  | 'IN_TRIP'
  | 'TRIP_ENDED_PAYMENT'
  | 'RATING'
  | 'NO_DRIVERS_UPFRONT'
  | 'QUEUED'
  | 'CANCELLED_DRIVER_REMATCHING'
  | 'RESTORING';

export type RideUiEvent =
  | { t: 'open_dest' }
  | { t: 'dest_chosen' }
  | { t: 'back_to_idle' }
  | { t: 'availability'; level: 'GOOD' | 'LOW' | 'NONE' }
  | { t: 'request_sent' }
  | { t: 'rider_cancelled' }
  | { t: 'queue_joined' }
  | { t: 'queue_left' }
  | { t: 'queue_expired' }
  | { t: 'srv_status'; status: string; reason?: string } // order:status_changed
  | { t: 'srv_exhausted' } // dispatch:exhausted
  | { t: 'payment_done' }
  | { t: 'rated' }
  | { t: 'restore'; status: string | null }; // cold start: GET /rides/active

export type RideAction = 'NONE' | 'SELF_HEAL';

/** Server order status → the UI state that renders it (recon 1.6 mapping). */
export function uiStateForOrderStatus(status: string | null | undefined): RideUiState {
  switch (status) {
    case 'PENDING': return 'REQUESTING';
    case 'DRIVER_ASSIGNED': return 'MATCHED';
    case 'DRIVER_EN_ROUTE': return 'DRIVER_EN_ROUTE';
    case 'DRIVER_ARRIVED': return 'DRIVER_ARRIVED';
    case 'RIDE_IN_PROGRESS': return 'IN_TRIP';
    case 'DELIVERED':
    case 'COMPLETED': return 'TRIP_ENDED_PAYMENT';
    default: return 'IDLE';
  }
}

const ACTIVE_STATES: RideUiState[] = ['REQUESTING', 'MATCHED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_TRIP', 'CANCELLED_DRIVER_REMATCHING', 'QUEUED'];

export function rideReducer(state: RideUiState, event: RideUiEvent): { state: RideUiState; action: RideAction } {
  const ok = (next: RideUiState): { state: RideUiState; action: RideAction } => ({ state: next, action: 'NONE' });
  const heal = (): { state: RideUiState; action: RideAction } => ({ state, action: 'SELF_HEAL' });

  switch (event.t) {
    case 'open_dest':
      return state === 'IDLE' || state === 'NO_DRIVERS_UPFRONT' ? ok('DEST_ENTRY') : heal();
    case 'dest_chosen':
      return state === 'DEST_ENTRY' || state === 'ROUTE_PREVIEW' ? ok('ROUTE_PREVIEW') : heal();
    case 'back_to_idle':
      return ok('IDLE');
    case 'availability':
      // T3: zero supply takes over the CTA area BEFORE a request exists.
      if (state === 'ROUTE_PREVIEW' && event.level === 'NONE') return ok('NO_DRIVERS_UPFRONT');
      if (state === 'NO_DRIVERS_UPFRONT' && event.level !== 'NONE') return ok('ROUTE_PREVIEW');
      return ok(state);
    case 'request_sent':
      return state === 'ROUTE_PREVIEW' || state === 'NO_DRIVERS_UPFRONT' || state === 'QUEUED' ? ok('REQUESTING') : heal();
    case 'rider_cancelled':
      return ok('IDLE'); // server already accepted the cancel; render it
    case 'queue_joined':
      return ok('QUEUED');
    case 'queue_left':
    case 'queue_expired':
      return state === 'QUEUED' ? ok('IDLE') : ok(state);
    case 'srv_exhausted':
      // T6/T20: exhaustion is a HANDOFF to the queue offer, not a dead end.
      return state === 'REQUESTING' || state === 'CANCELLED_DRIVER_REMATCHING' ? ok('QUEUED') : heal();
    case 'srv_status': {
      // T18: a driver cancel with the ride surviving = continuity, not IDLE.
      if (event.status === 'PENDING' && event.reason === 'driver_cancelled' && ACTIVE_STATES.includes(state)) {
        return ok('CANCELLED_DRIVER_REMATCHING');
      }
      if (event.status === 'CANCELLED') return ok('IDLE');
      const next = uiStateForOrderStatus(event.status);
      if (next === 'IDLE') return heal(); // unknown server status → refetch, never crash
      // Re-delivery/ordering tolerance: any server status maps directly; a
      // PENDING while rematching keeps the continuity screen (radar back).
      if (next === 'REQUESTING' && state === 'CANCELLED_DRIVER_REMATCHING') return ok('CANCELLED_DRIVER_REMATCHING');
      return ok(next);
    }
    case 'payment_done':
      return state === 'TRIP_ENDED_PAYMENT' ? ok('RATING') : heal();
    case 'rated':
      return ok('IDLE');
    case 'restore':
      // T21: land EXACTLY where the ride is; no active ride → IDLE.
      return ok(event.status ? uiStateForOrderStatus(event.status) : 'IDLE');
    default:
      return heal();
  }
}
