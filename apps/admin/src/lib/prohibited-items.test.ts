import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROHIBITED_CLASSES } from './api';
import { PROHIBITED_CLASS_LABELS } from './prohibited-items';

// [GUARDRAILS §8 · R4] The console's "Remove as" list and its class words cannot drift from the server's: a class
// the console does not offer cannot be chosen when a person removes an item, and a class it cannot name reads blank
// in the queue. (Until R4 the console had no DRUGS entry at all.)
describe('[§8 · R4] the prohibited classes match the server, class for class', () => {
  const api = readFileSync(join(process.cwd(), '../api/src/modules/compliance/prohibited-items.ts'), 'utf8');

  it('the console offers every class the server judges, in the server\'s order', () => {
    const block = /export const PROHIBITED_CLASSES: readonly ProhibitedClass\[\] = \[([\s\S]*?)\];/.exec(api);
    if (!block) throw new Error('PROHIBITED_CLASSES not found in the API');
    const server = [...block[1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    expect(server).toContain('LEGAL_SERVICES');
    expect([...PROHIBITED_CLASSES]).toEqual(server);
  });

  it('the console names every class in the server\'s words', () => {
    const block = /export const PROHIBITED_CLASS_LABELS: Readonly<Record<ProhibitedClass, string>> = \{([\s\S]*?)\};/.exec(api);
    if (!block) throw new Error('PROHIBITED_CLASS_LABELS not found in the API');
    const server = Object.fromEntries([...block[1]!.matchAll(/^\s*([A-Z_]+): '([^']+)',/gm)].map((m) => [m[1]!, m[2]!]));
    expect(server['WEAPONS']).toBe('firearms, ammunition and replicas');
    expect(PROHIBITED_CLASS_LABELS).toEqual(server);
  });
});
