import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MMG_MONEY_MOVED, mmgMoneyMoved } from './mmg-pay-words';
import { ATTESTABLE_PAYMENT_STATUSES, canAttestPayment } from './vendor-hub';

// The board decides "paid" and "the store may confirm" with the SERVER's own
// sets, so the two can never drift: money moved = MMG_MONEY_MOVED
// (apps/api/src/modules/order/order.service.ts), confirmable =
// ATTESTABLE_PAYMENT_STATUSES (apps/api/src/modules/vendor/mmg-attestation.ts).
const API = join(__dirname, '..', '..', '..', 'api', 'src', 'modules');
const strings = (src: string, name: string) => {
  const line = src.split('\n').find((l) => l.includes(`const ${name}`));
  if (!line) throw new Error(`${name} not found`);
  return [...line.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
};

describe('the board\'s payment sets are the server\'s', () => {
  it('money moved matches MMG_MONEY_MOVED', () => {
    const server = strings(readFileSync(join(API, 'order', 'order.service.ts'), 'utf8'), 'MMG_MONEY_MOVED');
    expect([...MMG_MONEY_MOVED].sort()).toEqual(server);
    for (const status of server) expect(mmgMoneyMoved(status)).toBe(true);
    expect(mmgMoneyMoved('PENDING')).toBe(false);
  });
  it('confirmable matches ATTESTABLE_PAYMENT_STATUSES', () => {
    const server = strings(readFileSync(join(API, 'vendor', 'mmg-attestation.ts'), 'utf8'), 'ATTESTABLE_PAYMENT_STATUSES');
    expect([...ATTESTABLE_PAYMENT_STATUSES].sort()).toEqual(server);
    for (const status of server) expect(canAttestPayment(status)).toBe(true);
    expect(canAttestPayment('CLAIMED')).toBe(false);
  });
});
