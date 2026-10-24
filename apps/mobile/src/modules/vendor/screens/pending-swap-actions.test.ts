import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [SUBSTITUTION · owner live test 17 Oct 2026] "The restaurant can't say ready
// to pick up unless the customer accepts." While a swap waits on the customer,
// the store phone hid EVERY line action (`!pending`), so the store could only
// wait. Now it reads when the wait ends and what then happens, and it can take
// the item off instead at any time (not on MMG, whose total the server keeps
// fixed in-app). The harness has no React Native renderer, so the screen is
// pinned as a source contract (as pickup-handover.test.ts); the sentence runs
// for real in ../../orders/substitutionCopy.test.ts.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const detail = strip(readFileSync(join(process.cwd(), 'src/modules/vendor/screens/VendorOrderDetailScreen.tsx'), 'utf8'));

describe('the store is never stuck waiting on a swap answer', () => {
  it('a pending line says when the wait ends and what then happens', () => {
    expect(detail).toContain("import { storeSwapWaitText } from '../../orders/substitutionCopy';");
    expect(detail).toContain('{pending && storeSwapWaitText(it.substituteDecideBy, order.paymentMethod) ? (');
  });

  it('a pending line offers Remove item instead, through the same line-removal call, never on MMG', () => {
    const at = detail.indexOf("{pickable && pending && order.paymentMethod !== 'MOBILE_MONEY' ? (");
    expect(at).toBeGreaterThan(-1);
    const block = detail.slice(at);
    const action = block.slice(0, block.indexOf(') : null}'));
    expect(action).toContain('onPress={() => picking.refundLine.mutate({ orderId: order.id, lineId: it.id })}');
    expect(action).toContain('Remove item instead');
    expect(action).toContain('disabled={picking.refundLine.isPending}');
  });
});
