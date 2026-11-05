import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderStatementHtml, statementPeriod } from '../modules/order/statement';

// ---------------------------------------------------------------------------
// [FULL-LAUNCH 5 Nov 2026] A statement row is an instant: an earning at 21:30 in Guyana printed the next day on a
// server in UTC. Rows now read Guyana time. The period is a different thing, the dates someone asked for, and keeps
// its own labels. The process zone is forced so a Mac set near Guyana cannot pass this by accident.
// ---------------------------------------------------------------------------

const statement = (date: Date) => renderStatementHtml({
  currencyCode: 'GYD', title: 'Earnings', holder: 'Sample', periodLabel: 'THE-PERIOD', totalLabel: 'Total', totalAmount: 700, footNote: 'Foot',
  lines: [{ date, label: 'A delivery', amount: 700 }],
});

describe('[FULL-LAUNCH] statement rows print the Guyana date', () => {
  const zone = process.env['TZ'];
  beforeAll(() => { process.env['TZ'] = 'UTC'; });
  afterAll(() => { if (zone === undefined) delete process.env['TZ']; else process.env['TZ'] = zone; });

  it('the server is on UTC for this proof', () => {
    expect(new Date('2026-11-05T01:30:00Z').getHours()).toBe(1);
  });

  it('01:30Z on the 5th was the evening of the 4th', () => {
    const html = statement(new Date('2026-11-05T01:30:00Z'));
    expect(html).toContain('<td class="date">04 Nov 2026</td>');
    expect(html).not.toContain('05 Nov 2026');
  });

  it('13:30Z is the same day in both', () => {
    expect(statement(new Date('2026-11-05T13:30:00Z'))).toContain('<td class="date">05 Nov 2026</td>');
  });

  it('the period keeps the dates that were asked for', () => {
    expect(statementPeriod({ from: '2026-11-01', to: '2026-11-30' }).label).toBe('01 Nov 2026 — 30 Nov 2026');
  });
});
