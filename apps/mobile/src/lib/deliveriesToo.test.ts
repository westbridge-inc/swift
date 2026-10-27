import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DELIVERY_CARDS_CAPABILITY, deliveriesTooView, offerKindOf, serverKnowsTaxiAndDeliveries, switchTarget, workModeLink } from './deliveriesToo';

// [CARS-DELIVER · owner 8 + 25 Oct 2026] "Deliveries too" behind the server's CAR_DELIVERIES switch. The card says
// nothing unless the server says it can be set up now or is set up; the home link switches work mode only for an
// account with both profiles, offline, with no job.

describe('deliveriesTooView: the account card follows the server answer only', () => {
  it('no answer, a malformed answer, or no work mode yet: nothing', () => {
    for (const answer of [null, undefined, 'yes', 1, []]) expect(deliveriesTooView(answer, 'DRIVER')).toEqual({ show: false });
    expect(deliveriesTooView({ available: true, enabled: false }, null)).toEqual({ show: false });
  });

  it('switch off with nothing set up: nothing; "true"-ish strings are not true', () => {
    expect(deliveriesTooView({ available: false, enabled: false, reason: 'SWITCH_OFF' }, 'DRIVER')).toEqual({ show: false });
    expect(deliveriesTooView({ available: 'true', enabled: 'true' }, 'DRIVER')).toEqual({ show: false });
  });

  it('can be set up: offered to the taxi driver only, naming the car', () => {
    expect(deliveriesTooView({ available: true, enabled: false, vehicle: { label: 'Wagon Car' } }, 'DRIVER')).toMatchObject({
      show: true, state: 'offer', action: 'Add deliveries',
      body: 'Use your wagon car for store deliveries as well as taxi rides. Adding deliveries does not change your weekly fee, and you keep 100%.',
    });
    expect(deliveriesTooView({ available: true, enabled: false }, 'DRIVER')).toMatchObject({ state: 'offer', body: expect.stringContaining('Use your car for') });
    expect(deliveriesTooView({ available: true, enabled: false }, 'RIDER')).toEqual({ show: false });
  });

  it('set up: the switch goes to the other work mode', () => {
    expect(deliveriesTooView({ available: true, enabled: true }, 'DRIVER')).toMatchObject({ state: 'ready', action: 'Switch to deliveries', target: 'RIDER' });
    expect(deliveriesTooView({ available: true, enabled: true }, 'RIDER')).toMatchObject({ state: 'ready', action: 'Switch to taxi rides', target: 'DRIVER' });
  });

  it('set up, switch off since: paused, said plainly, no button', () => {
    const view = deliveriesTooView({ available: false, enabled: true, reason: 'SWITCH_OFF' }, 'DRIVER');
    expect(view).toEqual({ show: true, state: 'paused', title: 'Deliveries too', body: 'Deliveries by taxi car are paused on Swift for now. Taxi rides work as usual.' });
  });
});

describe('workModeLink: the home switch', () => {
  it('only for an account with both profiles, offline, with no job', () => {
    expect(workModeLink({ dual: true, kind: 'DRIVER', online: false, hasActiveJob: false })).toEqual({ show: true, target: 'RIDER', label: 'Switch to deliveries' });
    expect(workModeLink({ dual: true, kind: 'RIDER', online: false, hasActiveJob: false })).toEqual({ show: true, target: 'DRIVER', label: 'Switch to taxi rides' });
    expect(workModeLink({ dual: false, kind: 'DRIVER', online: false, hasActiveJob: false })).toEqual({ show: false });
    expect(workModeLink({ dual: true, kind: 'DRIVER', online: true, hasActiveJob: false })).toEqual({ show: false });
    expect(workModeLink({ dual: true, kind: 'DRIVER', online: false, hasActiveJob: true })).toEqual({ show: false });
    expect(workModeLink({ dual: true, kind: null, online: false, hasActiveJob: false })).toEqual({ show: false });
    expect(switchTarget('DRIVER')).toEqual({ target: 'RIDER', label: 'Switch to deliveries' });
  });

  it('the home screen shows it from this rule and switches through the server (switch-role), nothing else', () => {
    const home = readFileSync(join(process.cwd(), 'src/modules/mover/screens/MoverHomeScreen.tsx'), 'utf8');
    expect(home).toContain("const modeLink = workModeLink({ dual: dual === true, kind, online, hasActiveJob: !!activeJob });");
    expect(home).toContain('{modeLink.show ? (');
    expect(home).toContain('onPress={() => selectMoverKind.mutate(modeLink.target)}');
  });
});

// [CARS-DELIVER PR4 · COORD 26 Oct] "Taxi rides and deliveries": the taxi driver's toggle, and every offer card
// answered as the kind of job it is.
describe('PR4: taxi rides and deliveries', () => {
  it('the toggle shows in taxi mode only while the switch is on (available), worded for each state', () => {
    const off = deliveriesTooView({ available: true, enabled: true, takesDeliveries: false }, 'DRIVER');
    expect(off).toMatchObject({ state: 'ready', both: { on: false, label: 'Turn on taxi rides and deliveries' } });
    expect((off as { both: { line: string } }).both.line).toBe(
      'Turn on taxi rides and deliveries to also get store delivery offers when you are online with no ride — still one job at a time.');
    const on = deliveriesTooView({ available: true, enabled: true, takesDeliveries: true }, 'DRIVER');
    expect(on).toMatchObject({ state: 'ready', both: { on: true, label: 'Back to taxi rides only' } });
    expect((on as { both: { line: string } }).both.line).toBe(
      'Taxi rides and deliveries is on: when you are online with no ride, store delivery offers come too. After a delivery you go back to taxi rides and deliveries.');
    expect(deliveriesTooView({ available: true, enabled: true, takesDeliveries: true }, 'RIDER')).toMatchObject({ both: null });
    expect(deliveriesTooView({ available: false, enabled: true, reason: 'SWITCH_OFF', takesDeliveries: true }, 'DRIVER')).toMatchObject({ state: 'paused' });
  });

  // [REVIEW-F #2139 S4-3] The toggle follows the server exactly: the server refuses "on" while the car cannot deliver
  // (available false, e.g. VEHICLE_NOT_OFFERED), and a server without "taxi + deliveries" (#2128 only) sends no
  // takesDeliveries field and has no mode route, so a toggle there could only fail.
  it('no toggle unless the server says it can be set now (available) and knows the mode (takesDeliveries is a boolean)', () => {
    expect(deliveriesTooView({ available: false, enabled: true, reason: 'VEHICLE', takesDeliveries: false }, 'DRIVER')).toMatchObject({ state: 'ready', both: null });
    expect(deliveriesTooView({ available: true, enabled: true, reason: null }, 'DRIVER')).toMatchObject({ state: 'ready', both: null });
    expect(deliveriesTooView({ available: true, enabled: true, takesDeliveries: 'true' }, 'DRIVER')).toMatchObject({ state: 'ready', both: null });
    expect(deliveriesTooView({ available: true, enabled: true, takesDeliveries: null }, 'DRIVER')).toMatchObject({ state: 'ready', both: null });
  });

  // [REVIEW-F #2139 S2-2 · COORD 27 Oct] This app declares it can show a delivery card at taxi GO, only to a server
  // that knows "taxi + deliveries" (its deliveries answer carries takesDeliveries, whatever its value).
  it('the delivery-card capability: its name, and which servers hear it', () => {
    expect(DELIVERY_CARDS_CAPABILITY).toBe('CAR_DELIVERY_CARDS_V1');
    expect(serverKnowsTaxiAndDeliveries({ available: false, enabled: false, reason: 'SWITCH_OFF', takesDeliveries: false })).toBe(true);
    expect(serverKnowsTaxiAndDeliveries({ available: true, enabled: true, takesDeliveries: true })).toBe(true);
    for (const older of [null, undefined, {}, { available: true, enabled: true, reason: null }, { takesDeliveries: 'true' }, 'x', 12]) {
      expect(serverKnowsTaxiAndDeliveries(older)).toBe(false);
    }
  });

  it('offerKindOf: the server names the job; without it, the app kind as before', () => {
    expect(offerKindOf({ orderType: 'TAXI' }, 'RIDER')).toBe('DRIVER');
    expect(offerKindOf({ orderType: 'FOOD_DELIVERY' }, 'DRIVER')).toBe('RIDER');
    expect(offerKindOf({ orderType: 'COURIER' }, 'DRIVER')).toBe('RIDER');
    expect(offerKindOf({}, 'DRIVER')).toBe('DRIVER');
    expect(offerKindOf(null, 'RIDER')).toBe('RIDER');
    expect(offerKindOf({ orderType: '' }, 'DRIVER')).toBe('DRIVER');
  });

  it('the home answers each card as its own kind, and the offer hook recovers and marks cards by kind', () => {
    const home = readFileSync(join(process.cwd(), 'src/modules/mover/screens/MoverHomeScreen.tsx'), 'utf8');
    expect(home).toContain("const offerKind = offerKindOf(offer, k);");
    expect(home).toContain('const answerAccept = offerKind === k ? acceptOffer : acceptDelivery;');
    expect(home).toContain('const answerDecline = offerKind === k ? decline : declineDelivery;');
    expect(home).toContain('kind={offerKind}');
    expect(home).toContain("useDispatchOffers(kind, online, dual === true && kind === 'DRIVER')");
    const hook = readFileSync(join(process.cwd(), 'src/hooks/dispatchOffers.ts'), 'utf8');
    expect(hook).toContain("if (!data?.offer?.orderId && alsoDeliveries && kind === 'DRIVER') {");
    expect(hook).toContain("const api = offerKindOf(offer, kind) === 'DRIVER' ? driverApi : riderApi;");
  });
});
