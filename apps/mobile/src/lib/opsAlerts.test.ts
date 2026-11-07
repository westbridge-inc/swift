import { describe, expect, it } from 'vitest';
import { alertLine, guyanaTime, inScreenOrder, kindWords, refusalOf, type OpsAlertRow } from './opsAlerts';

// [DRILL-STORM · S-19] The words of a responder's page on the phone.

const row = (over: Partial<OpsAlertRow>): OpsAlertRow => ({
  id: 'a', kind: 'PLATFORM', title: 'Page', body: 'Body', createdAt: '2026-10-25T16:00:00.000Z', ackDeadlineAt: '2026-10-25T16:02:00.000Z', escalationLevel: 0, ...over,
});

describe('a page in words', () => {
  it('names the kind in words, never a code — an unknown kind reads as an operations page', () => {
    expect(kindWords('SOS')).toBe('SOS');
    expect(kindWords('DRILL')).toBe('Drill');
    expect(kindWords('PLATFORM')).toBe('Operations page');
    expect(kindWords('SOMETHING_NEW')).toBe('Operations page');
  });

  it('writes times in Guyana time, plain ASCII', () => {
    expect(guyanaTime('2026-10-25T16:35:30.000Z')).toBe('25 Oct, 12:35 pm');
    expect(guyanaTime('2026-10-25T03:59:00.000Z')).toBe('24 Oct, 11:59 pm');
    expect(/^[\x20-\x7e]+$/.test(guyanaTime(new Date().toISOString()))).toBe(true);
    expect(guyanaTime('not a date')).toBe('');
  });

  it('says when it opened, its deadline or that it is overdue, and how often it was re-paged', () => {
    const before = Date.parse('2026-10-25T16:01:00.000Z');
    const after = Date.parse('2026-10-25T16:30:00.000Z');
    expect(alertLine(row({}), before)).toBe('Operations page · opened 25 Oct, 12:00 pm · acknowledge by 25 Oct, 12:02 pm');
    expect(alertLine(row({ kind: 'SOS', escalationLevel: 1 }), after)).toBe('SOS · opened 25 Oct, 12:00 pm · overdue · re-paged 1 time');
    expect(alertLine(row({ escalationLevel: 3 }), after)).toBe('Operations page · opened 25 Oct, 12:00 pm · overdue · re-paged 3 times');
  });

  it('puts the page the person tapped first, then SOS pages, then the oldest', () => {
    const rows = [
      row({ id: 'old-platform', createdAt: '2026-10-25T10:00:00.000Z' }),
      row({ id: 'sos', kind: 'SOS', createdAt: '2026-10-25T15:00:00.000Z' }),
      row({ id: 'tapped', createdAt: '2026-10-25T16:00:00.000Z' }),
    ];
    expect(inScreenOrder(rows, 'tapped').map((r) => r.id)).toEqual(['tapped', 'sos', 'old-platform']);
    expect(inScreenOrder(rows, null).map((r) => r.id)).toEqual(['sos', 'old-platform', 'tapped']);
  });

  it('tells a refusal (not a responder), a signed-out session and a failure apart', () => {
    expect(refusalOf({ response: { status: 403 } })).toBe('not-a-responder');
    expect(refusalOf({ response: { status: 401 } })).toBe('signed-out');
    expect(refusalOf({ response: { status: 500 } })).toBe('failed');
    expect(refusalOf(new Error('Network Error'))).toBe('failed');
  });
});
