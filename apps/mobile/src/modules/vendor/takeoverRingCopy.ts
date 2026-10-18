/** [RINGER] What the new-order takeover's eyebrow promises, by what this
 *  phone really does: build 12 loops Swift's ring tone (the chime) with the
 *  buzz; builds 9-11 have only the buzz, so they never promise a chime. */
export function takeoverRingCopy(queued: number, canRing: boolean): string {
  const repeats = canRing ? 'chime repeats' : 'buzz repeats';
  return queued > 1
    ? `● ${queued} new orders · ${repeats} — first in, first`
    : `● New order · ${repeats} until you answer`;
}
