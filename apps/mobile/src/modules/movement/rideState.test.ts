import { describe, it, expect } from 'vitest';
import { rideReducer, uiStateForOrderStatus, type RideUiState, type RideUiEvent } from './rideState';

// Part 4's transition table, executed. The two laws under test: T18 (driver
// cancel = continuity, never a dump to IDLE) and the self-heal rule (unknown
// event for the state → refetch, never crash).

const step = (s: RideUiState, e: RideUiEvent) => rideReducer(s, e);

describe('the happy walk (T1→T16)', () => {
  it('runs IDLE → … → RATING → IDLE on the real event stream', () => {
    let r = step('IDLE', { t: 'open_dest' });
    expect(r.state).toBe('DEST_ENTRY');
    r = step(r.state, { t: 'dest_chosen' });
    expect(r.state).toBe('ROUTE_PREVIEW');
    r = step(r.state, { t: 'request_sent' });
    expect(r.state).toBe('REQUESTING');
    r = step(r.state, { t: 'srv_status', status: 'DRIVER_ASSIGNED' });
    expect(r.state).toBe('MATCHED');
    r = step(r.state, { t: 'srv_status', status: 'DRIVER_EN_ROUTE' });
    expect(r.state).toBe('DRIVER_EN_ROUTE');
    r = step(r.state, { t: 'srv_status', status: 'DRIVER_ARRIVED' });
    expect(r.state).toBe('DRIVER_ARRIVED');
    r = step(r.state, { t: 'srv_status', status: 'RIDE_IN_PROGRESS' });
    expect(r.state).toBe('IN_TRIP');
    r = step(r.state, { t: 'srv_status', status: 'DELIVERED' });
    expect(r.state).toBe('TRIP_ENDED_PAYMENT');
    r = step(r.state, { t: 'payment_done' });
    expect(r.state).toBe('RATING');
    r = step(r.state, { t: 'rated' });
    expect(r.state).toBe('IDLE');
  });
});

describe('scarcity states (T3, T6, T8-T10)', () => {
  it('zero supply takes over ROUTE_PREVIEW before any request; recovery returns it', () => {
    expect(step('ROUTE_PREVIEW', { t: 'availability', level: 'NONE' }).state).toBe('NO_DRIVERS_UPFRONT');
    expect(step('NO_DRIVERS_UPFRONT', { t: 'availability', level: 'GOOD' }).state).toBe('ROUTE_PREVIEW');
  });
  it('exhaustion is a handoff to QUEUED, and a queue match lands MATCHED', () => {
    expect(step('REQUESTING', { t: 'srv_exhausted' }).state).toBe('QUEUED');
    expect(step('QUEUED', { t: 'srv_status', status: 'DRIVER_ASSIGNED' }).state).toBe('MATCHED');
    expect(step('QUEUED', { t: 'queue_expired' }).state).toBe('IDLE');
  });
});

describe('T18 — driver cancel is continuity, never a dead end', () => {
  it('PENDING + reason driver_cancelled from any active state → REMATCHING (not IDLE)', () => {
    for (const s of ['MATCHED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'] as RideUiState[]) {
      expect(step(s, { t: 'srv_status', status: 'PENDING', reason: 'driver_cancelled' }).state).toBe('CANCELLED_DRIVER_REMATCHING');
    }
  });
  it('rematching resolves to MATCHED on the next assignment, or QUEUED on exhaustion; plain PENDING keeps the continuity screen', () => {
    expect(step('CANCELLED_DRIVER_REMATCHING', { t: 'srv_status', status: 'DRIVER_ASSIGNED' }).state).toBe('MATCHED');
    expect(step('CANCELLED_DRIVER_REMATCHING', { t: 'srv_exhausted' }).state).toBe('QUEUED');
    expect(step('CANCELLED_DRIVER_REMATCHING', { t: 'srv_status', status: 'PENDING' }).state).toBe('CANCELLED_DRIVER_REMATCHING');
  });
});

describe('self-heal + restore (T21/T22 + the hard rules)', () => {
  it('an event that makes no sense for the state refetches instead of crashing', () => {
    const r = step('IDLE', { t: 'payment_done' });
    expect(r.action).toBe('SELF_HEAL');
    expect(r.state).toBe('IDLE'); // state never lurches on a heal
    expect(step('RATING', { t: 'srv_status', status: 'SOMETHING_NEW' }).action).toBe('SELF_HEAL');
  });
  it('cold-start restore lands EXACTLY where the ride is', () => {
    expect(step('RESTORING', { t: 'restore', status: 'DRIVER_ARRIVED' }).state).toBe('DRIVER_ARRIVED');
    expect(step('RESTORING', { t: 'restore', status: 'RIDE_IN_PROGRESS' }).state).toBe('IN_TRIP');
    expect(step('RESTORING', { t: 'restore', status: null }).state).toBe('IDLE');
  });
  it('server statuses map 1:1 (recon 1.6)', () => {
    expect(uiStateForOrderStatus('PENDING')).toBe('REQUESTING');
    expect(uiStateForOrderStatus('DELIVERED')).toBe('TRIP_ENDED_PAYMENT');
    expect(uiStateForOrderStatus('COMPLETED')).toBe('TRIP_ENDED_PAYMENT');
    expect(uiStateForOrderStatus(null)).toBe('IDLE');
  });
  it('re-delivered events are idempotent (same state in, same state out)', () => {
    const once = step('IN_TRIP', { t: 'srv_status', status: 'RIDE_IN_PROGRESS' });
    expect(once).toEqual({ state: 'IN_TRIP', action: 'NONE' });
  });
});
