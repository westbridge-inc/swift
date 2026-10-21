/**
 * [GUARDRAILS §2 · REVIEW-F 18 Oct] The erasure register covers every table that holds a person's id.
 * Reads the generated schema (Prisma DMMF): a new table with a User relation or a `userId` column is red
 * here until someone decides what the account erasure does with it. A CLEARED entry must be a real delete
 * in the erasure code; the UNDECIDED backlog may only shrink.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { ERASURE_CLEARED, ERASURE_KEPT, ERASURE_UNDECIDED } from '../modules/user/account-erasure-register';

const models = Prisma.dmmf.datamodel.models;
const ERASURE_SOURCES = ['modules/user/account.service.ts', 'modules/user/upload-erasure.ts', 'modules/user/mover-object-erasure.ts']
  .map((f) => readFileSync(join(__dirname, '..', f), 'utf8')).join('\n');
/** 18 Oct measurement. Lower it when an entry is ruled; never raise it. */
const UNDECIDED_CEILING = 21;

/** Every `Model.column` that holds a person's id: a relation to User, or a `userId` column. */
function personIdColumns(): string[] {
  const links = new Set<string>();
  for (const m of models) {
    if (m.name === 'User') continue;
    for (const f of m.fields) {
      if (f.kind === 'object' && f.type === 'User') for (const c of f.relationFromFields ?? []) links.add(`${m.name}.${c}`);
      if (f.kind === 'scalar' && f.type === 'String' && f.name === 'userId') links.add(`${m.name}.${f.name}`);
    }
  }
  return [...links].sort();
}

/**
 * [#1877 owner wall] A CLEARED table behind the owner wall (FORCE RLS: the app role cannot delete another
 * person's rows) is deleted through its narrow SECURITY DEFINER eraser. It is still a real delete by that
 * person column, pinned end to end: the erasure calls the helper with the person's id, the helper calls the
 * function, and the function's newest definition deletes from that table by that column.
 */
const WALL_ERASERS: Record<string, { helper: string; fn: string; table: string }> = {
  'DeviceToken.userId': { helper: 'eraseUserDevices', fn: 'swift_owner_wall_erase_devices', table: 'device_tokens' },
};
function wallEraserDeletes(link: string): boolean {
  const { helper, fn, table } = WALL_ERASERS[link]!;
  const column = link.split('.')[1]!;
  if (!new RegExp(`\\b${helper}\\(tx, userId\\)`).test(ERASURE_SOURCES)) return false;
  const lib = readFileSync(join(__dirname, '..', 'lib', 'owner-rls.ts'), 'utf8');
  const body = lib.split(`export async function ${helper}(`)[1]?.split('\n}\n')[0] ?? '';
  if (!body.includes(`public.${fn}(`)) return false;
  const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const create = `CREATE OR REPLACE FUNCTION public.${fn}(`;
  const newest = readdirSync(dir).sort().reverse()
    .map((m) => { try { return readFileSync(join(dir, m, 'migration.sql'), 'utf8'); } catch { return ''; } })
    .find((sql) => sql.includes(create));
  const definition = newest?.split(create)[1]?.split('$$;')[0] ?? '';
  return definition.includes(`DELETE FROM public.${table} WHERE "${column}" = p_user_id`);
}

describe('the erasure register', () => {
  it('names every table that holds a person id: cleared by the erasure, kept for a reason, or an open question', () => {
    const lists = [ERASURE_CLEARED, ERASURE_KEPT, ERASURE_UNDECIDED];
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
      if (WALL_ERASERS[link]) return !wallEraserDeletes(link);
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
