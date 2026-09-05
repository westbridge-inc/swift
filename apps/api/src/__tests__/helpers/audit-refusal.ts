import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { runWithoutTenant } from '../../plugins/prisma';
import { withSuiteCapability } from '../../lib/test-target-lock';

// ---------------------------------------------------------------------------
// [ADM-002] REFUSE AN AUDIT ROW AT THE DATABASE — ONE WAY, FOR EVERY SUITE.
//
// The red test the clause asks for is "inject an audit-write failure and
// assert the state change did not commit". Six suites each installed their
// own BEFORE INSERT trigger on `audit_logs`, and each built its name as
// `swift_x_${nanoid(6)}`. nanoid's alphabet includes `-` and `_`: spliced
// into an identifier, ONE dash is `42601 syntax error at or near "-"`, and
// TWO dashes start an SQL comment that swallows the rest of the statement
// (`… at or near "BEGIN"`). About a 9% chance per suite per run; across six
// suites, roughly two in five full CI runs would go red for no reason at all,
// and the failing suite moved every time — which is the tell.
//
// So: one helper, one validated identifier, one place to change the DDL.
// ---------------------------------------------------------------------------

/** An id safe to splice into a SQL identifier: alphanumeric, lower-case. */
export function safeRunId(length = 8): string {
  return nanoid(length).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/** The trigger/function name for a suite: `swift_<tag>_refuse_<run>`, validated. */
export function refusalName(tag: string, run: string = safeRunId()): string {
  const name = `swift_${tag}_refuse_${run}`;
  if (!IDENTIFIER.test(name)) throw new Error(`audit-refusal: unsafe SQL identifier '${name}'`);
  return name;
}

/** Which rows the trigger refuses. Values are test-controlled and must not carry a quote. */
export type RefusalPredicate = { readonly entityId: string } | { readonly actionLike: string };

const literal = (value: string): string => {
  if (value.includes("'") || value.includes('\\')) throw new Error(`audit-refusal: predicate value may not contain quotes: ${value}`);
  return `'${value}'`;
};

type HasPrisma = { readonly prisma: PrismaClient };

const ddl = (app: HasPrisma, sql: string, why: string) =>
  withSuiteCapability('ddl', () => runWithoutTenant(async () => { await app.prisma.$executeRawUnsafe(sql); }, why));

/** Install (or replace) the refusal: a BEFORE INSERT trigger on `audit_logs` that raises for matching rows. */
export async function refuseAuditWhere(app: HasPrisma, name: string, predicate: RefusalPredicate): Promise<void> {
  if (!IDENTIFIER.test(name)) throw new Error(`audit-refusal: unsafe SQL identifier '${name}'`);
  const condition = 'entityId' in predicate
    ? `NEW."entityId" = ${literal(predicate.entityId)}`
    : `NEW."action" LIKE ${literal(predicate.actionLike)}`;
  await ddl(app, `
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $fn$
    BEGIN
      IF ${condition} THEN RAISE EXCEPTION 'injected audit refusal (%)', NEW."entityId"; END IF;
      RETURN NEW;
    END; $fn$ LANGUAGE plpgsql;`, 'audit-refusal:install');
  await ddl(app, `DROP TRIGGER IF EXISTS ${name} ON audit_logs;`, 'audit-refusal:install');
  await ddl(app, `CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${name}();`, 'audit-refusal:install');
}

/** Lift the refusal (the function stays until `dropAuditRefusal`). */
export async function allowAuditAgain(app: HasPrisma, name: string): Promise<void> {
  if (!IDENTIFIER.test(name)) throw new Error(`audit-refusal: unsafe SQL identifier '${name}'`);
  await ddl(app, `DROP TRIGGER IF EXISTS ${name} ON audit_logs;`, 'audit-refusal:allow');
}

/** afterAll: trigger and function both gone. Never throws. */
export async function dropAuditRefusal(app: HasPrisma, name: string): Promise<void> {
  if (!IDENTIFIER.test(name)) return;
  await ddl(app, `DROP TRIGGER IF EXISTS ${name} ON audit_logs;`, 'audit-refusal:cleanup').catch(() => {});
  await ddl(app, `DROP FUNCTION IF EXISTS ${name}();`, 'audit-refusal:cleanup').catch(() => {});
}
