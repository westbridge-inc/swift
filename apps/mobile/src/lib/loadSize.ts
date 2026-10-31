/**
 * [Owner, 31 Oct 2026] A store order is never refused for its size alone: while car deliveries are off, an order
 * past a motorbike's usual load is offered to motorbikes. The server marks it `oversize: true` on the offer card and
 * the board row (beside `estLoad`, which counts the bulk too), so the rider sees it before accepting and may decline
 * without it counting against them.
 * Only exactly `true` shows; an older server sends nothing and nothing shows.
 */
export const OVERSIZE_LOAD_LABEL = 'Very big load';

export function oversizeLoadLabel(job: { oversize?: unknown } | null | undefined): string | null {
  return job?.oversize === true ? OVERSIZE_LOAD_LABEL : null;
}
