import { afterEach, describe, expect, it } from 'vitest';
import { suspensionRetentionMs } from '../modules/billing/dunning-clock';

// [#1393] The shared dunning clock owns the churn deadline. It honours the
// same operator setting main's billing service read, BILLING_SUSPENSION_MAX_DAYS
// (30 days when unset or invalid), so moving the deadline onto the clock
// never silently drops a configured retention.
const DAY = 24 * 3_600_000;
const saved = process.env['BILLING_SUSPENSION_MAX_DAYS'];
afterEach(() => {
  if (saved === undefined) delete process.env['BILLING_SUSPENSION_MAX_DAYS'];
  else process.env['BILLING_SUSPENSION_MAX_DAYS'] = saved;
});

describe('suspension retention before churn', () => {
  it('follows BILLING_SUSPENSION_MAX_DAYS', () => {
    process.env['BILLING_SUSPENSION_MAX_DAYS'] = '45';
    expect(suspensionRetentionMs()).toBe(45 * DAY);
  });

  it.each([undefined, '', '0', '-3', 'thirty'])('is 30 days when the setting is %s', (value) => {
    if (value === undefined) delete process.env['BILLING_SUSPENSION_MAX_DAYS'];
    else process.env['BILLING_SUSPENSION_MAX_DAYS'] = value;
    expect(suspensionRetentionMs()).toBe(30 * DAY);
  });
});
