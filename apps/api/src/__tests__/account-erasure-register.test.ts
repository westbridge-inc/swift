/**
 * [GUARDRAILS §2 · REVIEW-F 18 Oct · #1879 S3-1] The erasure register covers every table that holds a person's id.
 * Reads the generated schema (Prisma DMMF) with the export register's rule (helpers/person-links): a new table
 * with a User or profile relation, or a person-named column, is red here until someone decides what the account
 * erasure does with it. A CLEARED entry must be a real delete in the erasure code; the UNDECIDED backlog may
 * only shrink.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERASURE_CLEARED, ERASURE_DEIDENTIFIED, ERASURE_KEPT, ERASURE_UNDECIDED } from '../modules/user/account-erasure-register';
import { NOT_A_PERSON } from '../modules/user/data-export-register';
import { personLinks } from './helpers/person-links';

const ERASURE_SOURCES = ['modules/user/account.service.ts', 'modules/user/upload-erasure.ts', 'modules/user/mover-object-erasure.ts', 'modules/user/erasure-coverage.ts']
  .map((f) => readFileSync(join(__dirname, '..', f), 'utf8')).join('\n');
/** 19 Oct measurement (the 18 Oct ceiling was 21 over the narrower census). Lower it when an entry is ruled; never raise it. */
const UNDECIDED_CEILING = 19;

/** Every `Model.column` that holds a person's id, less the columns the export register proved are not a person. */
function personIdColumns(): string[] {
  return personLinks().filter((l) => !NOT_A_PERSON[l]);
}

describe('the erasure register', () => {
  it('names every table that holds a person id: cleared by the erasure, de-identified, kept for a reason, or an open question', () => {
    const lists = [ERASURE_CLEARED, ERASURE_DEIDENTIFIED, ERASURE_KEPT, ERASURE_UNDECIDED];
    const unclassified = personIdColumns().filter((l) => !lists.some((r) => r[l]));
    expect(unclassified).toEqual([]);
    // Exactly one list each, and nothing classified that does not exist (a stale entry hides a renamed column).
    const known = new Set(personIdColumns());
    const entries = lists.flatMap((r) => Object.keys(r));
    expect(entries.filter((l, i) => entries.indexOf(l) !== i)).toEqual([]);
    expect(entries.filter((l) => !known.has(l))).toEqual([]);
    for (const r of lists) for (const [l, why] of Object.entries(r)) expect(why.length, l).toBeGreaterThan(10);
  });

  it('every CLEARED table is deleted by the erasure code, by that person column', () => {
    const missing = Object.keys(ERASURE_CLEARED).filter((link) => {
      const [model, column] = link.split('.') as [string, string];
      const client = model[0]!.toLowerCase() + model.slice(1);
      const where = column === 'userId' ? '(userId[ ,}]|userId: userId)' : `${column}: userId`;
      return !new RegExp(`\\.${client}\\.deleteMany\\(\\{ where: \\{ ${where}`).test(ERASURE_SOURCES);
    });
    expect(missing).toEqual([]);
  });

  it('the open questions only shrink', () => {
    expect(Object.keys(ERASURE_UNDECIDED).length).toBeLessThanOrEqual(UNDECIDED_CEILING);
  });
});
