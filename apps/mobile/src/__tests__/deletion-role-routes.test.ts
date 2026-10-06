import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
/** The body of the role's root stack function: the navigator every profile tab
 *  is nested in. A registration inside another tab's nested stack is unreachable
 *  from the profile tab (the vendor Menu-stack registration was exactly that). */
const rootStack = (file: string, name: string) => {
  const text = source(file);
  const start = text.search(new RegExp(`\\n(?:export )?function ${name}\\(`)) + 1;
  expect(start, name).toBeGreaterThan(0);
  const next = text.slice(start + 1).search(/\n(?:export )?function /);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
};
describe('deletion is reachable in every role profile', () => {
  it.each([
    ['navigation/CustomerStack.tsx', 'CustomerStack', 'modules/profile/screens/ProfileScreen.tsx'],
    ['modules/mover/MoverStack.tsx', 'MoverStack', 'modules/mover/screens/MoverAccountScreen.tsx'],
    ['modules/vendor/VendorStack.tsx', 'VendorStack', 'modules/vendor/screens/VendorAccountScreen.tsx'],
    // While ads are off (launch), AdvertiserStack shows the role picker; an
    // advertiser member deletes from the customer profile, where the server
    // routes them to the closure request. The enabled stack keeps the entry.
    ['modules/advertiser/AdvertiserStack.tsx', 'EnabledAdvertiserStack', 'modules/advertiser/screens/AdvertiserTeamScreen.tsx'],
  ])('%s registers the profile destination on the root stack', (stack, name, profile) => {
    expect(rootStack(stack, name)).toMatch(/name="PersonalData" component=\{PersonalDataScreen\}/);
    expect(source(profile)).toMatch(/navigate\??\.?(?:\.)?\(?'PersonalData'|navigate\('PersonalData'/);
  });
});
