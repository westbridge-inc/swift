// [REVIEW-M #1832 S3-1] A batch's clock that moves on with real time.
//
// A batch job takes its `now` once, when it starts (a test passes one to stand
// at a chosen instant). A long batch (hundreds of items, each with network or
// database work) that hands that same instant to every item dates a late item
// minutes in the past: money paths that compare the caller's clock with the
// database's (the return re-anchor proof refuses a clock more than a few
// minutes off) then fall back, and stamps and expiries read stale.
//
// `batchClock(start)` returns a function giving, for each item, the start
// instant plus the time the batch has run so far, read from the same clock as
// `new Date()` and never backwards. In production `start` is the run's own
// start, so each item gets the real time; a test's chosen instant stays
// chosen, plus the time its batch took; a test that freezes the clock (fake
// Date) freezes the batch clock with it, to the millisecond.
export type BatchClock = () => Date;

export function batchClock(start: Date, elapsedMs: () => number = elapsedSinceMs()): BatchClock {
  return () => new Date(start.getTime() + Math.max(0, elapsedMs()));
}

/** Milliseconds since this call, from the clock `new Date()` reads, never less
 *  than an earlier reading: a wall-clock step back never dates a later item
 *  before an earlier one. (Not the monotonic clock: a test that fakes Date
 *  must see the batch clock stand still with it.) */
export function elapsedSinceMs(): () => number {
  const origin = Date.now();
  let most = 0;
  return () => {
    most = Math.max(most, Date.now() - origin);
    return most;
  };
}
