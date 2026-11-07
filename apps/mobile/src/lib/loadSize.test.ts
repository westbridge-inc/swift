import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OVERSIZE_LOAD_LABEL, oversizeLoadLabel } from './loadSize';

// ---------------------------------------------------------------------------
// [Owner, 31 Oct 2026] A store order is never refused for its size alone: while
// car deliveries are off, an order past a motorbike's usual load is offered to
// motorbikes. The server marks it (`oversize: true`, beside the unchanged
// `estLoad`) so the rider sees it before accepting and may decline. The offer
// card and the board row both say so.
// ---------------------------------------------------------------------------

const SCREEN = readFileSync(join(process.cwd(), 'src', 'modules', 'mover', 'screens', 'MoverHomeScreen.tsx'), 'utf8');

describe('a very big load is said before the rider accepts', () => {
  it('only an order the server marks oversize gets the words', () => {
    expect(oversizeLoadLabel({ oversize: true })).toBe(OVERSIZE_LOAD_LABEL);
    expect(OVERSIZE_LOAD_LABEL).toBe('Very big load');
    for (const job of [{ oversize: false }, {}, { oversize: 'true' }, { oversize: 1 }, null, undefined]) {
      expect(oversizeLoadLabel(job as { oversize?: unknown } | null | undefined), JSON.stringify(job)).toBeNull();
    }
  });

  it('the offer card shows it beside the load pill, and the board row beside the load line', () => {
    expect(SCREEN).toContain("import { oversizeLoadLabel } from '../../../lib/loadSize';");
    const card = SCREEN.slice(SCREEN.indexOf('Judge the bag before you commit'));
    expect(card.slice(0, 900)).toMatch(/oversizeLoadLabel\(offer\)/);
    const board = SCREEN.slice(SCREEN.indexOf("{j.estLoad ? ` · ${j.estLoad} load` : ''}"));
    expect(board.slice(0, 200)).toMatch(/oversizeLoadLabel\(j\)/);
  });
});
