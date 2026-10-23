import { describe, expect, it } from 'vitest';
import { demandTapFor } from './demandTap';

// [row 54] The one decision behind a tap on "N waiting" — every branch true.
describe('demandTapFor', () => {
  it('on a job: no tap at all', () => {
    expect(demandTapFor({ online: true, hasActiveJob: true, boardCount: 3, isDriver: true })).toBeNull();
    expect(demandTapFor({ online: false, hasActiveJob: true, boardCount: 0, isDriver: false })).toBeNull();
  });
  it('online with jobs on the board: the board', () => {
    expect(demandTapFor({ online: true, hasActiveJob: false, boardCount: 1, isDriver: false })).toEqual({ kind: 'show-board' });
  });
  it('online, empty board: how the work arrives, in the mover’s own words', () => {
    expect(demandTapFor({ online: true, hasActiveJob: false, boardCount: 0, isDriver: false })).toEqual({
      kind: 'explain',
      title: 'Requests come to you as offers',
      body: 'Swift offers each order near you to an available rider. Stay online: when one is offered to you, it shows on this screen.',
    });
  });
  it('offline: GO, even with a stale board count', () => {
    const tap = demandTapFor({ online: false, hasActiveJob: false, boardCount: 4, isDriver: true });
    expect(tap?.kind).toBe('explain');
    expect(tap && 'title' in tap ? tap.title : '').toBe('Go online to take requests');
  });
});
