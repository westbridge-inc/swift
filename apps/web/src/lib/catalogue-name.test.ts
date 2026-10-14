import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGUE_LABEL, catalogueName } from './catalogue-name';

// Owner ruling (11 Oct 2026): the website names the items tab exactly like the
// app — by store type. The app's map lives in a file that imports React Native,
// so the web keeps a copy; this census keeps the two identical.
const APP = readFileSync(join(__dirname, '..', '..', '..', 'mobile', 'src', 'modules', 'vendor', 'shared.tsx'), 'utf8');

function appLabels(): Record<string, string> {
  const block = APP.slice(APP.indexOf('export const CATALOGUE_META'), APP.indexOf('export function catalogueMeta'));
  return Object.fromEntries([...block.matchAll(/^\s+([A-Z_]+): \{ label: '([^']+)'/gm)].map((m) => [m[1]!, m[2]!]));
}

describe('the items tab is named like the app', () => {
  it('uses the app\'s label for every store type', () => {
    const labels = appLabels();
    expect(Object.keys(labels).length).toBe(4);
    expect(CATALOGUE_LABEL).toEqual(labels);
    for (const [type, label] of Object.entries(labels)) expect(catalogueName(type)).toBe(label);
  });

  it('falls back like the app: a missing or unknown type reads as a restaurant', () => {
    expect(APP).toMatch(/CATALOGUE_META\[vendorType \?\? 'RESTAURANT'\] \?\? CATALOGUE_META\['RESTAURANT'\]/);
    expect(catalogueName(undefined)).toBe(CATALOGUE_LABEL.RESTAURANT);
    expect(catalogueName(null)).toBe(CATALOGUE_LABEL.RESTAURANT);
    expect(catalogueName('SOMETHING_NEW')).toBe(CATALOGUE_LABEL.RESTAURANT);
  });
});
