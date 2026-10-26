import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliveriesTooView, switchTarget, workModeLink } from './deliveriesToo';

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
