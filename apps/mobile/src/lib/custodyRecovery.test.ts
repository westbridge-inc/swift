import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RIDER_PROBLEM_REASONS,
  isHandoffCode,
  parseHolderCaseView,
  parsePartyCaseView,
  parseRelayTasks,
  storeCanConfirmReturn,
} from './custodyRecovery';

// [AF-MOB-006] The client reads what the server decided; it never invents a
// state, a code or a promise.

describe('the rider report reasons are the API’s, word for word', () => {
  it('matches RIDER_INCIDENT_REASONS in apps/api custody-case.ts, in order', () => {
    const api = readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'custody', 'custody-case.ts'), 'utf8');
    const block = api.match(/export const RIDER_INCIDENT_REASONS = \[([\s\S]*?)\] as const/);
    expect(block, 'the API list was found').toBeTruthy();
    const apiCodes = [...block![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(RIDER_PROBLEM_REASONS.map((r) => r.code)).toEqual(apiCodes);
    for (const r of RIDER_PROBLEM_REASONS) expect(r.label.length).toBeGreaterThan(3);
  });
});

describe('party view', () => {
  const ok = { caseId: 'c1', state: 'RETURN_REQUIRED', open: true, ownedBySupport: true, headline: 'Order coming back to you', body: 'Bring it back.' };
  it('reads a well-formed view and refuses a malformed one', () => {
    expect(parsePartyCaseView(ok)).toEqual(ok);
    expect(parsePartyCaseView(null)).toBeNull();
    expect(parsePartyCaseView({ ...ok, headline: '' })).toBeNull();
    expect(parsePartyCaseView({ ...ok, caseId: 7 })).toBeNull();
  });
  it('the store confirms a return only for a store order already on its way back', () => {
    const v = parsePartyCaseView(ok);
    expect(storeCanConfirmReturn(v, 'RETURNING', 'FOOD_DELIVERY')).toBe(true);
    expect(storeCanConfirmReturn(v, 'EN_ROUTE_DELIVERY', 'FOOD_DELIVERY')).toBe(false);
    expect(storeCanConfirmReturn(v, 'RETURNING', 'COURIER')).toBe(false);
    expect(storeCanConfirmReturn(parsePartyCaseView({ ...ok, state: 'SUPPORT_HOLD' }), 'RETURNING', 'FOOD_DELIVERY')).toBe(false);
    expect(storeCanConfirmReturn(null, 'RETURNING', 'FOOD_DELIVERY')).toBe(false);
  });
});

describe('holder view', () => {
  it('shows only a well-formed six-digit code, and never a negative float', () => {
    const v = parseHolderCaseView({
      caseId: 'c1', state: 'TRANSFER_IN_PROGRESS', open: true, version: 3, youHoldTheGoods: true,
      transferCode: '042913', floatToCollect: 3000, relay: { firstName: 'Ana' }, instruction: 'Show the code.',
    });
    expect(v).toMatchObject({ transferCode: '042913', floatToCollect: 3000, relayFirstName: 'Ana', version: 3 });
    expect(parseHolderCaseView({ caseId: 'c1', state: 'X', instruction: 'i', transferCode: '12345' })!.transferCode).toBeNull();
    expect(parseHolderCaseView({ caseId: 'c1', state: 'X', instruction: 'i', floatToCollect: -5 })!.floatToCollect).toBe(0);
    expect(parseHolderCaseView({ state: 'X', instruction: 'i' })).toBeNull();
  });
});

describe('relay tasks', () => {
  it('keeps well-formed tasks and drops the rest', () => {
    const tasks = parseRelayTasks([
      { caseId: 'c1', version: 2, orderNumber: 'SW-1', holder: { firstName: 'Bo', lat: 6.8, lng: -58.1 }, floatToBring: 3000, instruction: 'Meet Bo.' },
      { caseId: '', instruction: 'x' },
      'junk',
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ caseId: 'c1', holderFirstName: 'Bo', holderLat: 6.8, floatToBring: 3000 });
    expect(parseRelayTasks(null)).toEqual([]);
  });
  it('a handoff code is exactly six digits', () => {
    expect(isHandoffCode('123456')).toBe(true);
    expect(isHandoffCode('12345')).toBe(false);
    expect(isHandoffCode('12345a')).toBe(false);
  });
});
