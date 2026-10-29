import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeoverRingCopy } from './takeoverRingCopy';

// [RINGER] The takeover promises only what this phone does: a chime on build
// 12 (the ring tone), the buzz on builds 9-11. And it rings until the order is
// answered, settles, or its accept clock runs out.
describe('the new-order takeover rings, and says so truthfully', () => {
  it('build 12 promises the chime; builds 9-11 promise only the buzz', () => {
    expect(takeoverRingCopy(1, true)).toBe('● New order · chime repeats until you answer');
    expect(takeoverRingCopy(3, true)).toBe('● 3 new orders · chime repeats — first in, first');
    expect(takeoverRingCopy(1, false)).toBe('● New order · buzz repeats until you answer');
    expect(takeoverRingCopy(2, false)).toBe('● 2 new orders · buzz repeats — first in, first');
    expect(takeoverRingCopy(1, false)).not.toMatch(/chime/);
  });

  it('wires the ring to the open decision and the copy to the binary', () => {
    const screen = readFileSync(join(process.cwd(), 'src/modules/vendor/NewOrderTakeover.tsx'), 'utf8');
    expect(screen).toContain('const expired = Number.isFinite(respondByMs) && respondByMs <= nowTs;');
    expect(screen).toContain('useJobRing(!!orderId && !settled && !expired);');
    expect(screen).toContain('const [canRing] = useState(hasJobRing);');
    expect(screen).toContain('{takeoverRingCopy(queue.length, canRing)}');
    expect(screen).not.toMatch(/'● New order · chime repeats until you answer'/);
    expect(screen).not.toContain('Vibration');
  });
});
