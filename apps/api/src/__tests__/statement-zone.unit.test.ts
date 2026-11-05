import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderStatementHtml, statementPeriod } from '../modules/order/statement';
import { periodLabel } from '../modules/order/statement.routes';

// ---------------------------------------------------------------------------
// [FULL-LAUNCH 5 Nov 2026] A statement is what an earner shows a bank. Its rows are instants and its period a run of
// days, and both read Guyana: on a UTC server the window closed at 20:00 on its last day, the default window could end
// tomorrow, and a row could print outside the label above it. The zone moves dates, never a figure.
// The process zone is forced so a Mac set near Guyana cannot pass this by accident.
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

  it('dates that are asked for print as asked, and each is a whole day in Guyana', () => {
    const period = statementPeriod({ from: '2026-11-01', to: '2026-11-30' });
    expect(period.label).toBe('01 Nov 2026 — 30 Nov 2026');
    expect(period.from.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-12-01T03:59:59.999Z');
  });

  it('a date with a time of day still means that day in Guyana', () => {
    const period = statementPeriod({ from: '2026-11-01T01:30:00.000Z', to: '2026-11-05T13:30:00.000Z' });
    expect(period.label).toBe('31 Oct 2026 — 05 Nov 2026');
  });

  // 21:00 in Guyana on the 5th is already the 6th on a UTC server.
  const EVENING = new Date('2026-11-06T01:00:00.000Z');

  it('the default window ends today in Guyana, never tomorrow, and starts 30 days before it', () => {
    const period = statementPeriod({}, EVENING);
    expect(period.label).toBe('06 Oct 2026 — 05 Nov 2026');
    expect(period.from.toISOString()).toBe('2026-10-06T04:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-11-06T03:59:59.999Z');
  });

  it('no row inside a window prints outside its label: the first and last instants', () => {
    for (const period of [statementPeriod({}, EVENING), statementPeriod({ from: '2026-11-01', to: '2026-11-30' })]) {
      const [first, last] = period.label.split(' — ');
      expect(statement(period.from)).toContain(`<td class="date">${first}</td>`);
      expect(statement(period.to)).toContain(`<td class="date">${last}</td>`);
    }
  });

  it('the signed link opens the same label the app was shown', () => {
    for (const period of [statementPeriod({}, EVENING), statementPeriod({ from: '2026-11-01', to: '2026-11-30' })]) {
      expect(periodLabel(period.from.toISOString(), period.to.toISOString())).toBe(period.label);
    }
  });

  it('a row keeps its amount: the zone moves a date, never a figure', () => {
    const before = statement(new Date('2026-11-05T01:30:00Z')).replace('04 Nov 2026', 'DATE');
    const after = statement(new Date('2026-11-05T13:30:00Z')).replace('05 Nov 2026', 'DATE');
    expect(before).toBe(after);
  });
});
