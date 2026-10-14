/**
 * PUT /driver/location and PUT /rider/location — the answer to an ACCEPTED fix.
 *
 * The mover app checkpoints a fix, and keeps its background location task
 * running, only on an explicit acceptance. These routes used to answer an
 * accepted fix with a bare `{ success: true }`, which the app read as "not an
 * answer": after three of them it stopped its location task, about 15 s after
 * GO, while the screen still said online. A refusal has always carried
 * `data: { accepted: false, reason }` and is unchanged.
 *
 * The app's own tests feed this exact value through its real reply adapter
 * (apps/mobile/src/lib/moverBackgroundRuntime.ts), and the API suites pin the
 * same literal on the wire, so the two sides cannot drift apart again.
 */
export function moverLocationAccepted() {
  // A fresh object per reply: nothing downstream can share or mutate it.
  return { success: true as const, data: { accepted: true as const } };
}
