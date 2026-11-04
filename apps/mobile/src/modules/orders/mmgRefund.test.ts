import { describe, expect, it } from 'vitest';
import { mmgRefundTone, parseMmgRefundView } from './mmgRefund';

// [BUG-HUNT-2 G08] The screens render what the server projected. Anything unreadable is no card, never a card that claims something.
const owed = { state: 'OWED', amount: '1300.00', line: 'You owe GY$1,300', sendId: null, canAnswer: false, canMarkSent: true };

describe('[G08] parseMmgRefundView', () => {
  it('reads the server\'s view', () => expect(parseMmgRefundView(owed)).toEqual(owed));
  it.each([[null], [undefined], [{}], [{ ...owed, state: 'REFUNDED' }], [{ ...owed, line: '  ' }], [{ ...owed, amount: 1300 }]])('no card for %j', (raw) => {
    expect(parseMmgRefundView(raw)).toBeNull();
  });
  it('a question needs a send to answer', () => {
    expect(parseMmgRefundView({ ...owed, state: 'SENT', canAnswer: true, sendId: null })!.canAnswer).toBe(false);
    expect(parseMmgRefundView({ ...owed, state: 'SENT', canAnswer: true, sendId: 's1' })).toMatchObject({ canAnswer: true, sendId: 's1' });
  });
  it('a door is only what the server says', () => {
    expect(parseMmgRefundView({ ...owed, canMarkSent: 'yes' })!.canMarkSent).toBe(false);
  });
  it('late and argued look different from done', () => {
    expect(mmgRefundTone(parseMmgRefundView({ ...owed, state: 'OVERDUE' })!)).toBe('warning');
    expect(mmgRefundTone(parseMmgRefundView({ ...owed, state: 'DISPUTED' })!)).toBe('warning');
    expect(mmgRefundTone(parseMmgRefundView({ ...owed, state: 'DONE' })!)).toBe('success');
    expect(mmgRefundTone(parseMmgRefundView(owed)!)).toBe('neutral');
  });
});
