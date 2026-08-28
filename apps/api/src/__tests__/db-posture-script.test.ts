import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * [GRD-1 Movement 0 · WS-15 / 15.4] `scripts/db-posture.sql` asks the questions
 * the application's own test suite structurally cannot, because they are
 * properties of the DATABASE and of the role it is reached through, not of the
 * code. A green API suite tells you nothing about whether the connecting role
 * bypasses row-level security.
 *
 * This is a small gate on a checklist, and it exists for one reason: the checks
 * below were each added because their absence hid something, and a checklist
 * silently loses entries. The most important one is check 3.
 *
 * It does not execute the SQL — the file is psql-native (`\echo` section
 * headers), CI has no psql client, and a database-shaped test here would prove
 * something different from what the script is for. Stated rather than papered
 * over: the script's correctness is verified by running it, and it was, against
 * the live dev database on 2026-08-28.
 */

const script = readFileSync(join(process.cwd(), '../../scripts/db-posture.sql'), 'utf8');

describe('the posture checklist keeps its checks', () => {
  it('asks whether the connecting role is a superuser or bypasses RLS', () => {
    // A superuser or BYPASSRLS role is exempt from every policy, so the policy
    // count means nothing for that connection however high it is.
    expect(script).toMatch(/rolsuper/);
    expect(script).toMatch(/rolbypassrls/);
  });

  it('asks who OWNS the tables', () => {
    // The owner bypasses non-forced RLS. "Which role owns these" is half of
    // whether the wall is load-bearing.
    expect(script).toMatch(/tableowner/);
  });

  it('DISTINGUISHES RLS ENABLED FROM RLS FORCED — the check a policy count cannot make', () => {
    // The one that matters most. ENABLE applies policies to ordinary roles;
    // FORCE also applies them to the table owner. The repo's CI check counts
    // POLICIES, which is a different question, and a green policy count next to
    // an unforced table reads as a wall that is not there.
    //
    // Asserted on the COUNTING form, not on the identifier appearing anywhere:
    // the first version of this test matched the word, so deleting the count
    // and leaving the mention behind kept it green. Both numbers have to be
    // produced side by side or they cannot be compared, which is the whole
    // point of the check.
    expect(script).toMatch(/count\(\*\)\s*FILTER\s*\(WHERE relrowsecurity\)/);
    expect(script).toMatch(/count\(\*\)\s*FILTER\s*\(WHERE relforcerowsecurity\)/);
    // And the follow-up that names the offenders, not just the totals.
    expect(script).toMatch(/relrowsecurity AND NOT c\.relforcerowsecurity/);
  });

  it('finds tenant-bearing tables with no policy at all', () => {
    expect(script).toMatch(/tenantId/);
    expect(script).toMatch(/pg_policy/);
  });

  it('looks for money stored as floating point', () => {
    expect(script).toMatch(/double precision/);
  });

  it('reads the connection and statement budgets, INCLUDING per-role overrides', () => {
    // Per-role settings are what actually bind the application; the global
    // values can look fine while the app's own role has none.
    expect(script).toMatch(/max_connections/);
    expect(script).toMatch(/statement_timeout/);
    expect(script).toMatch(/idle_in_transaction_session_timeout/);
    expect(script).toMatch(/lock_timeout/);
    expect(script).toMatch(/pg_db_role_setting/);
  });

  it('checks for sequential ids on externally-visible tables', () => {
    expect(script).toMatch(/nextval/);
  });

  it('finds unindexed foreign keys, ordered by table size', () => {
    // This is the check that found the missing sessions.userId index, and the
    // ORDERING is what made it the first row rather than one of a hundred.
    // Asserted on the ORDER BY, not merely on the function appearing: an
    // unordered list of unindexed keys is a list nobody works through.
    expect(script).toMatch(/contype = 'f'/);
    expect(script).toMatch(/ORDER BY pg_total_relation_size\([^)]*\) DESC/);
  });

  it('surfaces the fastest-growing tables for the retention cross-check', () => {
    expect(script).toMatch(/pg_stat_user_tables/);
    expect(script).toMatch(/n_live_tup/);
  });

  it('says what a GOOD answer looks like for every check', () => {
    // Output nobody can interpret is output nobody reads. Each check states its
    // own passing condition so the person running it in an incident does not
    // have to reconstruct the intent.
    const goodLines = script.split('\n').filter((l) => /GOOD:/.test(l));
    expect(goodLines.length).toBeGreaterThanOrEqual(8);
  });

  it('is read-only', () => {
    // It runs against production databases. It must never be able to change one.
    const forbidden = /\b(INSERT INTO|UPDATE\s+\w|DELETE FROM|DROP\s|ALTER\s+TABLE|TRUNCATE|CREATE\s+(TABLE|INDEX)|GRANT|REVOKE)\b/i;
    const statements = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('--') && !line.trim().startsWith('\\echo'));
    expect(statements.join('\n')).not.toMatch(forbidden);
  });
});
