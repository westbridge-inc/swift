import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { goOnlineDoorFor } from './goOnlineDoor';

// [NO-DEAD-ENDS] A refused GO comes with the button that fixes it.

describe('goOnlineDoorFor', () => {
  it('keeps the two liveness doors exactly as they were', () => {
    expect(goOnlineDoorFor('LIVENESS_CHECK_REQUIRED', 'DRIVER')).toEqual({ label: 'Take the selfie check', route: 'LivenessCheck', params: { profile: 'DRIVER' } });
    expect(goOnlineDoorFor('LIVENESS_LOCKED', 'RIDER')).toEqual({ label: 'Contact support', route: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Identity check locked my account' } });
  });
  it('documents, every weekly-fee refusal and a safety review each open the screen that resolves them', () => {
    expect(goOnlineDoorFor('VERIFICATION_REQUIRED', 'RIDER')?.route).toBe('MoverDocuments');
    for (const code of ['SUBSCRIPTION_PAST_DUE', 'SUBSCRIPTION_SUSPENDED', 'SUBSCRIPTION_REQUIRED']) {
      expect(goOnlineDoorFor(code, 'DRIVER'), code).toEqual({ label: 'Open Weekly fee', route: 'WeeklyFee' });
    }
    expect(goOnlineDoorFor('SAFETY_SUSPENDED', 'RIDER')).toMatchObject({ route: 'GetHelp', params: { category: 'SAFETY' } });
  });
  it('an unknown or missing code gets no invented button', () => {
    expect(goOnlineDoorFor('SOMETHING_NEW', 'RIDER')).toBeNull();
    expect(goOnlineDoorFor(undefined, 'RIDER')).toBeNull();
  });
  it('every door names a route the mover stack registers', () => {
    const stack = readFileSync(new URL('../modules/mover/MoverStack.tsx', import.meta.url), 'utf8');
    for (const route of ['LivenessCheck', 'GetHelp', 'MoverDocuments', 'WeeklyFee']) expect(stack).toContain(`name="${route}"`);
  });
  it('the mover home renders the door for the refusal it shows', () => {
    const home = readFileSync(new URL('../modules/mover/screens/MoverHomeScreen.tsx', import.meta.url), 'utf8');
    expect(home).toContain('const goDoor = goOnlineDoorFor(errCode, kind)');
    expect(home).toMatch(/goDoor \? \([\s\S]{0,200}label=\{goDoor\.label\}[\s\S]{0,200}navigation\?\.navigate\?\.\(goDoor\.route, goDoor\.params\)/);
  });
});
