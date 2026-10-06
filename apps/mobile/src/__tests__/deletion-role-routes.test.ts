import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
/** The body of the exported stack function: the navigator every profile tab is
 *  nested in. A registration inside another tab's nested stack is unreachable
 *  from the profile tab (the vendor Menu-stack registration was exactly that). */
const exportedStack = (file: string, name: string) => {
  const text = source(file);
  const start = text.indexOf(`export function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = text.slice(start + 1).search(/\n(?:export )?function /);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
};
describe('deletion is reachable in every role profile', () => {
  it.each([
    ['navigation/CustomerStack.tsx', 'CustomerStack', 'modules/profile/screens/ProfileScreen.tsx'],
    ['modules/mover/MoverStack.tsx', 'MoverStack', 'modules/mover/screens/MoverAccountScreen.tsx'],
    ['modules/vendor/VendorStack.tsx', 'VendorStack', 'modules/vendor/screens/VendorAccountScreen.tsx'],
    ['modules/advertiser/AdvertiserStack.tsx', 'AdvertiserStack', 'modules/advertiser/screens/AdvertiserTeamScreen.tsx'],
  ])('%s registers the profile destination on the root stack', (stack, name, profile) => {
    expect(exportedStack(stack, name)).toMatch(/name="PersonalData" component=\{PersonalDataScreen\}/);
    expect(source(profile)).toMatch(/navigate\??\.?(?:\.)?\(?'PersonalData'|navigate\('PersonalData'/);
  });
});
