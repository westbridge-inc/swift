import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
describe('deletion is reachable in every role profile', () => {
  it.each([
    ['navigation/CustomerStack.tsx', 'modules/profile/screens/ProfileScreen.tsx'],
    ['modules/mover/MoverStack.tsx', 'modules/mover/screens/MoverAccountScreen.tsx'],
    ['modules/vendor/VendorStack.tsx', 'modules/vendor/screens/VendorAccountScreen.tsx'],
    ['modules/advertiser/AdvertiserStack.tsx', 'modules/advertiser/screens/AdvertiserTeamScreen.tsx'],
  ])('%s registers the profile destination', (stack, profile) => {
    expect(source(stack)).toMatch(/name="PersonalData" component=\{PersonalDataScreen\}/);
    expect(source(profile)).toMatch(/navigate\??\.?(?:\.)?\(?'PersonalData'|navigate\('PersonalData'/);
  });
});
