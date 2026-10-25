import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardTapFor, pendingOrderIds } from './boardTaps';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner 22 Oct 2026 "fast taps and simple"] The store board's
// taps. The decisions are plain functions (boardTaps); the board itself has no
// React Native renderer in this harness, so how it uses them is a source-level
// contract, the same shape as screens/pickup-handover.test.ts.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const board = read('src/modules/vendor/screens/VendorOps.tsx');
const detail = read('src/modules/vendor/screens/VendorOrderDetailScreen.tsx');
const hooks = read('src/hooks/vendorops.ts');

describe('[STORE-DASH] what a tap on a board card does', () => {
  it('a forward step goes to the server in one tap', () => {
    for (const a of ['accept', 'preparing', 'ready', 'delivered', 'complete-appointment', 'confirm-payment'] as const) {
      expect(cardTapFor(a)).toBe('send');
    }
  });
  it('Reject asks for the reason first', () => {
    expect(cardTapFor('reject')).toBe('reject');
  });
  it('the takeaway hand-over opens the order, where the customer\'s code is typed — never a request with no code', () => {
    expect(cardTapFor('complete-pickup')).toBe('open');
  });
});

describe('[STORE-DASH] which orders are waiting', () => {
  it('names each order with a tap still out, once', () => {
    expect([...pendingOrderIds([{ id: 'a', action: 'accept' }, { id: 'b', action: 'ready' }, { id: 'a', action: 'accept' }])].sort()).toEqual(['a', 'b']);
  });
  it('ignores anything that is not an order tap', () => {
    expect(pendingOrderIds([undefined, null, {}, { id: '' }, { id: 7 }, 'x']).size).toBe(0);
  });
});

describe('[STORE-DASH] the board uses them', () => {
  it('every card waits only for its own order (no shared busy flag)', () => {
    expect(board).not.toMatch(/const busy = orderAction\.isPending/);
    expect(board).not.toMatch(/busy=\{busy\}/);
    expect(board.match(/busy=\{pendingIds\.has\(/g)?.length).toBe(3);
    expect(hooks).toMatch(/mutationKey: ORDER_ACTION_KEY/);
    expect(hooks).toMatch(/filters: \{ mutationKey: ORDER_ACTION_KEY, status: 'pending' \}/);
  });
  it('every card routes its tap through cardTapFor (the old inline reject-or-send is gone)', () => {
    expect(board).toMatch(/const tap = cardTapFor\(action\)/);
    expect(board).toMatch(/else if \(tap === 'open'\) openOrder\(o\)/);
    expect(board).not.toMatch(/action === 'reject' \? setRejecting/);
  });
  it('the whole live queue is on the board from the start', () => {
    expect(board).toMatch(/const \[queueOpen, setQueueOpen\] = useState\(true\)/);
  });
  it('the tapped button says it is working', () => {
    expect(board).toMatch(/loading=\{busy && a\.action !== 'reject'\}/);
  });
  it('an order opens from the board copy; its lines stay read-only until its own read lands', () => {
    expect(hooks).toMatch(/placeholderData: \(\) => boardOrder\(qc\.getQueryData\(\['vendor', 'orders'\]\), id\)/);
    expect(detail).toMatch(/const pickable = !isPlaceholderData && /);
  });
});
