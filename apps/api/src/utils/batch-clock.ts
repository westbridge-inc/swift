// [REVIEW-M #1832 S3-1] The clock each item of a batch is dated with.
//
// A batch job used to take its `now` once, when it started, and hand that one
// instant to every item. A long batch (hundreds of items, each with network or
// database work) then dated a late item minutes in the past: money paths that
// compare the caller's clock with the database's (the return re-anchor proof
// refuses a clock more than a few minutes off) fell back, and stamps and
// expiries read stale.
//
// `batchClock(at)`:
//   - no `at` (production: the jobs call without one): each item is dated when
//     it is really processed (`new Date()`). A test that freezes Date (fake
//     timers) gets the frozen instant, to the millisecond;
//   - an `at` (a caller standing at a chosen instant: a test, a replay):
//     exactly that instant for every item, as before.
export type BatchClock = () => Date;

export function batchClock(at?: Date): BatchClock {
  if (at) {
    const fixed = at.getTime();
    return () => new Date(fixed);
  }
  return () => new Date();
}
