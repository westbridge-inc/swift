import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MMG_MONEY_MOVED, OUT_OF_STOCK_WORDS, canMarkOutOfStock, customerDeciding, lineQuestion, lineStockWords, mmgAwaitingPayment, nothingToAccept,
} from './storeOrderRules';
import { takeoverSettled } from './acceptClock';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner 22 Oct 2026, O-4] The store's "Out of stock" rules, the
// server's contract (#2043) in one plain file the phone and the web share, and
// [REVIEW-F S4-1/S4-2 on #2032] the unpaid-MMG rule pinned on the phone with
// one money-moved set.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const L = (subStatus?: string | null, substituteName?: string | null) => ({ subStatus, substituteName });
const waiting = (...items: unknown[]) => ({ status: 'PENDING', items });

describe('[O-4] what a line\'s question is', () => {
  it('PENDING with nothing proposed is a removal question; with a substitute, a swap', () => {
    expect(lineQuestion(L('PENDING', null))).toBe('removal');
    expect(lineQuestion(L('PENDING', '  '))).toBe('removal');
    expect(lineQuestion(L('PENDING', 'Mauby'))).toBe('swap');
  });
  it('no open question otherwise', () => {
    for (const s of ['NONE', 'APPROVED', 'REJECTED', 'REFUNDED', null, undefined]) expect(lineQuestion(L(s)), String(s)).toBeNull();
  });
});

describe('[O-4] when the store waits, and when there is nothing to accept', () => {
  it('a waiting order with any open question: the customer is deciding', () => {
    expect(customerDeciding(waiting(L('NONE'), L('PENDING', null)))).toBe(true);
    expect(customerDeciding(waiting(L('NONE'), L('APPROVED')))).toBe(false);
    // only a WAITING order waits on the customer
    expect(customerDeciding({ status: 'PREPARING', items: [L('PENDING', 'Mauby')] })).toBe(false);
    expect(customerDeciding({ status: 'PENDING' })).toBe(false);
  });
  it('every item came off: nothing to accept; an empty or partly-removed order is not that', () => {
    expect(nothingToAccept(waiting(L('REFUNDED'), L('REJECTED')))).toBe(true);
    expect(nothingToAccept(waiting(L('REFUNDED'), L('NONE')))).toBe(false);
    expect(nothingToAccept(waiting())).toBe(false);
    expect(nothingToAccept({ status: 'ACCEPTED', items: [L('REFUNDED')] })).toBe(false);
  });
  it('"Out of stock" is offered only on a waiting order\'s line nobody asked about yet', () => {
    expect(canMarkOutOfStock(waiting(), L('NONE'))).toBe(true);
    expect(canMarkOutOfStock(waiting(), L(null))).toBe(true);
    expect(canMarkOutOfStock(waiting(), L(undefined))).toBe(true);
    for (const s of ['PENDING', 'APPROVED', 'REJECTED', 'REFUNDED']) expect(canMarkOutOfStock(waiting(), L(s)), s).toBe(false);
    for (const status of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'CANCELLED']) expect(canMarkOutOfStock({ status }, L('NONE')), status).toBe(false);
  });
  it('each line says what happened to it', () => {
    expect(lineStockWords(L('PENDING', null))).toBe(OUT_OF_STOCK_WORDS.removalAsked);
    expect(lineStockWords(L('PENDING', 'Mauby'))).toBe('Asked the customer about a swap: Mauby');
    expect(lineStockWords(L('REFUNDED'))).toBe('Removed — not charged');
    expect(lineStockWords(L('NONE'))).toBeNull();
  });
  it('the takeover stops ringing while the customer decides (the order stays on the board)', () => {
    expect(takeoverSettled(waiting(L('PENDING', null)))).toBe(true);
    expect(takeoverSettled(waiting(L('NONE')))).toBe(false);
  });
});

describe('[REVIEW-F S4-1/S4-2 on #2032] an unpaid MMG order at Accepted: "Paid by MMG" is its one step', () => {
  it('money moved = CAPTURED or the store\'s own CLAIMED report (the server\'s MMG_MONEY_MOVED)', () => {
    expect([...MMG_MONEY_MOVED]).toEqual(['CAPTURED', 'CLAIMED']);
    expect(mmgAwaitingPayment({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' })).toBe(true);
    expect(mmgAwaitingPayment({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'AUTHORIZED' })).toBe(true);
    expect(mmgAwaitingPayment({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' })).toBe(false);
    expect(mmgAwaitingPayment({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' })).toBe(false);
    expect(mmgAwaitingPayment({ paymentMethod: 'CASH', paymentStatus: 'PENDING' })).toBe(false);
  });
  it('the phone\'s statusActions reads these rules (no inlined money list), and so does the web copy', () => {
    for (const p of ['src/modules/vendor/shared.tsx', '../web/src/lib/vendor-hub.ts']) {
      const src = read(p);
      expect(src, p).toMatch(/if \(\(s === 'ACCEPTED' \|\| s === 'CONFIRMED'\) && mmgAwaitingPayment\(order\)\) return \[\];/);
      expect(src, p).toMatch(/if \(customerDeciding\(order\) \|\| nothingToAccept\(order\)\) return \[\{ label: isAppt \? 'Decline' : 'Reject', action: 'reject' \}\];/);
      expect(src, p).not.toMatch(/\['CAPTURED', 'CLAIMED'\]/);
    }
    expect(read('../web/src/lib/mmg-pay-words.ts')).toMatch(/export \{ MMG_MONEY_MOVED \} from '..\/..\/..\/mobile\/src\/modules\/vendor\/storeOrderRules'/);
  });
});

describe('[O-4] the phone takeover and board use them (source contract: no React Native renderer here)', () => {
  const takeover = read('src/modules/vendor/NewOrderTakeover.tsx');
  const board = read('src/modules/vendor/screens/VendorOps.tsx');
  it('each takeover item has the one-tap "Out of stock" that asks about THAT line', () => {
    expect(takeover).toMatch(/\{canMarkOutOfStock\(o, i\) \? \(/);
    expect(takeover).toMatch(/onPress=\{\(\) => picking\.refundLine\.mutate\(\{ orderId: current\.orderId, lineId: i\.id \}\)\}/);
  });
  it('a takeover whose every item came off offers no ACCEPT, only the words and Reject', () => {
    expect(takeover).toMatch(/\{nothingLeft \? \(\s*<T [^>]*>\s*\{OUT_OF_STOCK_WORDS\.nothing\}/);
  });
  it('the board card says why there is no Accept', () => {
    expect(board).toMatch(/\{customerDeciding\(order\) \? OUT_OF_STOCK_WORDS\.deciding : OUT_OF_STOCK_WORDS\.nothing\}/);
  });
});
