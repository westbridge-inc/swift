import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// COPY-FIX-1's mobile screens. The patterns name copy users could see;
// implementation comments are removed before the check.
const checks: Array<[string, RegExp]> = [
  ['../modules/orders/screens/DeliveryScreen.tsx', /the server received|waiting for the server|server (?:will |marked |assigned |released |status|preview|check|estimate)|server timestamps|dispatch pool|stops fulfilment|live catalogue/i],
  ['../modules/movement/screens/TaxiScreen.tsx', /the server confirmed|the server recorded|active-ride poll/i],
  ['../modules/safety/SosCeremony.tsx', /server[’']s clock|Swift pages its team/i],
  ['../modules/profile/screens/ProfileScreen.tsx', /cart and session leave this device/i],
  ['../modules/vendor/VendorStack.tsx', /your session ended/i],
  ['../modules/vendor/screens/VendorOps.tsx', /live catalogue facts|catalogue unavailable|checking live catalogue/i],
  ['../modules/vendor/screens/VendorMenuScreen.tsx', /live catalogue|last loaded catalogue|86&apos;d|line is refunded/i],
];

describe('mobile plain language census', () => {
  it.each(checks)('%s does not bring back developer wording', (path, oldCopy) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(oldCopy);
  });
});
