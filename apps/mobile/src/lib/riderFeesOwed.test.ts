import { describe, it, expect } from 'vitest';
import { classifyOwedLedger, markPaidPrompt } from './riderFeesOwed';

// ---------------------------------------------------------------------------
// [MOB-046] A DEBT TO A RIDER DOES NOT DISAPPEAR BECAUSE A QUERY FAILED.
//
// The "You owe riders" card read its rows like this:
//
//     const rows = q.data?.unsettled ?? [];
//     if (rows.length === 0) return null;
//
// A failed read produced an empty list, and an empty list removed the card
// from the screen. To the store owner that is not an outage — it is the
// absence of a debt. The delivery fees a rider paid out of their own pocket,
// gone from the only screen that shows them.
//
// And "Mark paid" was one tap: no confirmation, no naming of who or how much,
// and a failure that showed nowhere. It is an attestation that cash left the
// till and reached a person.
// ---------------------------------------------------------------------------

const row = (id: string, amount = 400) => ({ id, amount, status: 'PENDING', orderNumber: 'A-100', rider: { name: 'Deon' } });
const ok = { unsettled: [row('s1'), row('s2')], summary: { owed: 800 } };

describe('[MOB-046] the card never disappears because a read failed', () => {
  it('a failed read is UNAVAILABLE, not "you owe nothing" — the defect, in one case', () => {
    const view = classifyOwedLedger({ isLoading: false, error: new Error('offline'), data: undefined, fetched: true });
    expect(view.state).toBe('unavailable');
    // and the total is unknown, never 0 standing in for it
    expect(view.owed).toBeNull();
  });

  it('EMPTY requires a successful read that found nothing — the only reason to show nothing', () => {
    const view = classifyOwedLedger({ isLoading: false, error: null, data: { unsettled: [], summary: { owed: 0 } }, fetched: true });
    expect(view.state).toBe('empty');
    expect(view.owed).toBe(0);
  });

  it('a read still in flight is loading, not empty', () => {
    expect(classifyOwedLedger({ isLoading: true, error: null, data: undefined, fetched: false }).state).toBe('loading');
    expect(classifyOwedLedger({ isLoading: false, error: null, data: undefined, fetched: false }).state).toBe('loading');
  });

  it('a successful read with debts is ready, with its rows and its total', () => {
    const view = classifyOwedLedger({ isLoading: false, error: null, data: ok, fetched: true });
    expect(view.state).toBe('ready');
    expect(view.rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(view.owed).toBe(800);
  });

  it('a payload that is not a ledger is unavailable — a schema change is an outage, not a paid debt', () => {
    for (const data of [null, 'nothing', 42, { unsettled: 'soon' }, { summary: { owed: 5 } }]) {
      expect(classifyOwedLedger({ isLoading: false, error: null, data, fetched: true }).state, JSON.stringify(data)).toBe('unavailable');
    }
  });

  it('a ledger with a row the screen cannot identify is unavailable, not partly shown — dropping a row understates the debt', () => {
    const view = classifyOwedLedger({
      isLoading: false, error: null, fetched: true,
      data: { unsettled: [row('s1'), { amount: 500 }], summary: { owed: 900 } },
    });
    expect(view.state).toBe('unavailable');
    expect(view.rows).toEqual([]);
  });

  it('a missing or nonsense total is unknown, never a number the screen would print as fact', () => {
    for (const owed of [undefined, null, 'lots', Number.NaN]) {
      const view = classifyOwedLedger({ isLoading: false, error: null, fetched: true, data: { unsettled: [row('s1')], summary: { owed } } });
      expect(view.state).toBe('ready');
      expect(view.owed).toBeNull();
    }
  });

  it('an error outranks stale data — a cached ledger never renders as current during an outage', () => {
    expect(classifyOwedLedger({ isLoading: false, error: new Error('500'), data: ok, fetched: true }).state).toBe('unavailable');
  });
});

describe('[MOB-046] marking cash paid says who, and how much', () => {
  it('names the rider, the amount and the order — a mis-tap on the wrong row is the same mistake as not paying', () => {
    const prompt = markPaidPrompt(row('s1'), '$400');
    expect(prompt.title).toContain('Deon');
    expect(prompt.title).toContain('$400');
    expect(prompt.body).toContain('#A-100');
    expect(prompt.body).toContain('cash');
    expect(prompt.confirm).toContain('$400');
  });

  it('still asks when the rider has no name — an unnamed row is not a reason to skip the question', () => {
    const prompt = markPaidPrompt({ id: 's9', amount: 250, rider: null }, '$250');
    expect(prompt.title).toContain('this rider');
    expect(prompt.title).toContain('$250');
    expect(prompt.confirm).toContain('$250');
  });

  it('the confirm text states the amount, so the button is never just "Yes"', () => {
    expect(markPaidPrompt(row('s1'), '$1,200').confirm).toBe('Yes, I paid $1,200');
  });
});
