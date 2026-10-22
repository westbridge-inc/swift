/**
 * [Restore replays erasures] A restored backup must lose every row the account erasure deletes.
 *
 * The erasure register (account-erasure-register.ts) is the list of what the erasure clears. This
 * pins the restore replay to it: every CLEARED link must have (1) a replay DELETE of that table by
 * that person column in deploy/restore-replay-erasures.sql, and (2) the live rows the erasure kept for
 * it in the closed_account_rows ledger entry, so the copy keeps exactly what the live database kept.
 * A link ruled CLEARED later is red here until the restore replays it too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { ERASURE_CLEARED } from '../modules/user/account-erasure-register';

const DEPLOY = join(__dirname, '../../../../deploy');
const REPLAY = readFileSync(join(DEPLOY, 'restore-replay-erasures.sql'), 'utf8');
const LEDGER = readFileSync(join(DEPLOY, 'restore-erasure-ledger.sql'), 'utf8');
const KEPT_ROWS = LEDGER.match(/^-- ledger: closed_account_rows\n(SELECT .+)$/m)?.[1] ?? '';

function table(model: string): { name: string; column: (field: string) => string } {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`no model ${model}`);
  return {
    name: m.dbName ?? m.name,
    column: (field) => m.fields.find((f) => f.name === field)?.dbName ?? field,
  };
}
const sqlName = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('the restore replays every erasure the register clears', () => {
  const links = Object.keys(ERASURE_CLEARED);
  it('the register has links to check', () => { expect(links.length).toBeGreaterThan(5); });

  it.each(links)('%s: the replay deletes it from a restored copy', (link) => {
    const [model, field] = link.split('.') as [string, string];
    const t = table(model);
    const del = new RegExp(`DELETE FROM ${escape(sqlName(t.name))} t USING restore_closed_ids x WHERE t\\."${escape(t.column(field))}" = x\\.id`);
    expect(REPLAY, `${link}: no replay DELETE FROM ${t.name} by ${field}`).toMatch(del);
  });

  it.each(links)('%s: the live rows the erasure kept travel in the ledger, so the copy keeps exactly those', (link) => {
    const [model, field] = link.split('.') as [string, string];
    const t = table(model);
    const kept = new RegExp(`SELECT '${escape(t.name)}'(?: AS tbl)?, .+? FROM ${escape(sqlName(t.name))} WHERE "${escape(t.column(field))}" IN \\(SELECT id FROM users WHERE phone = 'deleted:' \\|\\| id\\)`);
    expect(KEPT_ROWS, `${link}: no closed_account_rows entry for ${t.name}`).toMatch(kept);
  });
});
