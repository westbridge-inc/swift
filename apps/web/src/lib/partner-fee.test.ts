// [CHAINS · REVIEW-M #2211] The fee a partner reads is the fee charged: payInfo's figure, else the biller's rule
// (a custom rate is never above the list rate).
import { describe, expect, it } from 'vitest';
import { chargedWeeklyFee } from './partner-fee';

describe('chargedWeeklyFee', () => {
  it('payInfo\'s weeklyFeeGyd wins', () => {
    expect(chargedWeeklyFee({ weeklyFeeGyd: 9000, customRate: '12000', weeklyRate: '15000' })).toBe(9000);
  });
  it('a custom rate under the list rate is charged', () => {
    expect(chargedWeeklyFee({ customRate: '12000', weeklyRate: '15000' })).toBe(12000);
  });
  it('a custom rate above the list rate is never shown: the lower list rate is charged', () => {
    expect(chargedWeeklyFee({ customRate: '18000', weeklyRate: '15000' })).toBe(15000);
  });
  it('the list rate alone, and null with no figure', () => {
    expect(chargedWeeklyFee({ weeklyRate: '15000' })).toBe(15000);
    expect(chargedWeeklyFee({})).toBeNull();
  });
});
