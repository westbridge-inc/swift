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

// [Fable review on #1454] The expired code, the relay rider's error handling and
// the resolved-case noise.
import { partyCaseWorthShowing, relayErrorAction } from './custodyRecovery';

describe('an expired handoff code is never shown as live', () => {
  const base = { caseId: 'c1', state: 'TRANSFER_IN_PROGRESS', open: true, version: 2, youHoldTheGoods: true, floatToCollect: 3000, instruction: 'Show the code.' };
  const NOW = Date.parse('2026-10-05T12:00:00.000Z');
  it('the server saying it expired wins', () => {
    const v = parseHolderCaseView({ ...base, transferCode: '123456', codeExpired: true, transferCodeExpiresAt: '2026-10-05T11:59:00.000Z' }, NOW);
    expect(v).toMatchObject({ codeExpired: true, transferCode: null, floatToCollect: 0 });
  });
  it('a code whose expiry has passed on this phone is dropped too, between polls', () => {
    const v = parseHolderCaseView({ ...base, transferCode: '123456', codeExpired: false, transferCodeExpiresAt: '2026-10-05T11:59:59.000Z' }, NOW);
    expect(v).toMatchObject({ codeExpired: true, transferCode: null });
  });
  it('a live code before its expiry is shown', () => {
    const v = parseHolderCaseView({ ...base, transferCode: '123456', codeExpired: false, transferCodeExpiresAt: '2026-10-05T12:20:00.000Z' }, NOW);
    expect(v).toMatchObject({ codeExpired: false, transferCode: '123456', transferCodeExpiresAt: '2026-10-05T12:20:00.000Z' });
  });
});

describe('the relay rider’s handoff errors', () => {
  const http = (status: number, code: string, message = 'server words') => ({ response: { status, data: { error: { code, message } } } });
  it('a lost answer keeps the attempt key and the dialog: the retry must REPLAY, not try again', () => {
    expect(relayErrorAction(new Error('Network Error'))).toMatchObject({ rotateKey: false, closeDialog: false });
  });
  it('a request still in flight (DUPLICATE_REQUEST) keeps the key — rotating would burn a second attempt', () => {
    expect(relayErrorAction(http(409, 'DUPLICATE_REQUEST'))).toMatchObject({ rotateKey: false, closeDialog: false, refresh: false });
  });
  it('a refused code is a new attempt next time, in the same dialog — with the field cleared, so a reflex second tap cannot resend it', () => {
    expect(relayErrorAction(http(400, 'INVALID_TRANSFER_CODE'))).toMatchObject({ rotateKey: true, closeDialog: false, refresh: true, clearCode: true, message: 'server words' });
  });
  it('a kept attempt keeps what was typed (the retry is the same request)', () => {
    expect(relayErrorAction(new Error('Network Error')).clearCode).toBe(false);
    expect(relayErrorAction(http(409, 'DUPLICATE_REQUEST')).clearCode).toBe(false);
  });
  it.each(['TRANSFER_NOT_PENDING', 'MAX_ATTEMPTS', 'TRANSFER_CODE_EXPIRED', 'RECOVERY_STALE'])('%s closes the dialog and refreshes the list', (code) => {
    expect(relayErrorAction(http(409, code))).toMatchObject({ closeDialog: true, refresh: true });
  });
  it('a handoff that is gone reads as plain words, whatever the server sent', () => {
    const a = relayErrorAction(http(404, 'NOT_FOUND', 'RecoveryCase with id cm123 not found'));
    expect(a).toMatchObject({ closeDialog: true, refresh: true });
    expect(a.message).toBe('This handoff was called off or given to another rider.');
  });
});

describe('a resolved case that says nothing new is not shown', () => {
  const v = (state: string, open = false) => ({ caseId: 'c', state, open, ownedBySupport: true, headline: 'h', body: 'b' });
  it('open cases, returns and handoffs are shown; delivered and closed are not', () => {
    expect(partyCaseWorthShowing(v('SUPPORT_HOLD', true))).toBe(true);
    expect(partyCaseWorthShowing(v('RETURNED'))).toBe(true);
    expect(partyCaseWorthShowing(v('TRANSFERRED'))).toBe(true);
    expect(partyCaseWorthShowing(v('DELIVERED'))).toBe(false);
    expect(partyCaseWorthShowing(v('CLOSED'))).toBe(false);
    expect(partyCaseWorthShowing(null)).toBe(false);
  });
});

describe('the report reasons are thumb-sized', () => {
  it('each reason row is at least 48dp tall', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'mover', 'CustodyRecoverySection.tsx'), 'utf8');
    const heights = [...src.matchAll(/minHeight:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(48);
  });
});
