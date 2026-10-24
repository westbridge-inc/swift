// ---------------------------------------------------------------------------
// [row 54 · owner 9 Oct] WHAT A TAP ON "N WAITING" DOES — always something true.
//
// The earner home draws real demand on the map: waiting ride requests (rounded
// ~300 m server-side, never a customer's exact spot) and "N waiting" clusters.
// Those markers looked tappable and did nothing. A tap now answers with what
// the mover can actually do about that demand:
//   - online, with jobs on the open board: open the board (the real list of
//     jobs this mover can take, each with its own Accept);
//   - online, board empty: say how the work reaches them (as an offer, on this
//     screen) instead of pretending the dot is a job they can grab;
//   - offline: say that GO is the way to receive it. A map tap never switches
//     the mover online by itself (the band and the GO ring are the explicit
//     controls for that);
//   - on a job: nothing (the active job is the screen's business).
// No customer, address or exact location is ever named.
// ---------------------------------------------------------------------------

export type DemandTap =
  | { kind: 'show-board' }
  | { kind: 'explain'; title: string; body: string };

export function demandTapFor(input: {
  online: boolean;
  hasActiveJob: boolean;
  boardCount: number;
  isDriver: boolean;
}): DemandTap | null {
  if (input.hasActiveJob) return null;
  const mover = input.isDriver ? 'driver' : 'rider';
  const work = input.isDriver ? 'ride request' : 'order';
  if (!input.online) {
    return {
      kind: 'explain',
      title: 'Go online to take requests',
      body: `Tap GO. Once you're online, Swift can offer you a ${work} near you on this screen.`,
    };
  }
  if (input.boardCount > 0) return { kind: 'show-board' };
  return {
    kind: 'explain',
    title: 'Requests come to you as offers',
    body: `Swift offers each ${work} near you to an available ${mover}. Stay online: when one is offered to you, it shows on this screen.`,
  };
}
