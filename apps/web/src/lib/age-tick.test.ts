import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGE_TICK_LABEL, AGE_TICK_REQUIRED } from './age-tick';

// [Owner ruling 15 Oct 2026] The words beside the website's 18+ tick are the words the API anchors the
// consent-ledger row to (a version is a promise about specific words). Read from the API source as text,
// so a change on either side without the other fails here.
const API_AGE = readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'auth', 'age-declaration.ts'), 'utf8');

describe('the website 18+ tick says the recorded words', () => {
  it('the label is the API declaration, word for word', () => {
    const m = /export const AGE_DECLARATION_V1 = '([^']+)';/.exec(API_AGE);
    expect(m?.[1]).toBe(AGE_TICK_LABEL);
  });

  it('the refusal the site shows is the API refusal, word for word', () => {
    const m = /export const AGE_CONFIRMATION_MESSAGE = '([^']+)';/.exec(API_AGE);
    expect(m?.[1]).toBe(AGE_TICK_REQUIRED);
  });
});
