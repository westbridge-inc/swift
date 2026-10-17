/**
 * [Row 331 · DSAR-ERASURE (b)] The export register covers every person link and every column.
 * Reads the generated schema (Prisma DMMF), so a new table or column that points at a person,
 * or a new column on an exported table, is red here until someone decides: export it, or say why not.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { ACCOUNT_FIELDS, ALSO_COVERED, EXPORT_REGISTER, NOT_A_PERSON, OMIT_RULES, WITHHELD } from '../modules/user/data-export-register';

const models = Prisma.dmmf.datamodel.models;
const byName = new Map(models.map((m) => [m.name, m]));
const PERSON_NAME = /(^|[a-z])([uU]serId|[cC]ustomerId|raterId|rateeId|[cC]reatedBy|reporterId|[sS]enderId|[rR]ecipientId|[aA]ccountId|subjectId|[sS]ubjectUserId|[pP]assengerUserId|[dD]riverUserId|requesterId|actorId|ownerUserId|accessorUserId|counterpartyUserId|setByUserId|[uU]serIds?)$/;
const PROFILES = ['Rider', 'Driver', 'ServiceProvider'];

/** Every `Model.column` that points at a person: a User relation, a person-named column, or a mover/provider profile. */
function personLinks(): string[] {
  const links = new Set<string>();
  for (const m of models) {
    if (m.name === 'User') continue;
    for (const f of m.fields) {
      if (f.kind === 'object' && (f.type === 'User' || PROFILES.includes(f.type))) for (const c of f.relationFromFields ?? []) links.add(`${m.name}.${c}`);
      if (f.kind === 'scalar' && f.type === 'String' && (PERSON_NAME.test(f.name) || /^(riderId|driverId|providerId)$/.test(f.name))) links.add(`${m.name}.${f.name}`);
    }
  }
  return [...links].sort();
}

function ruleReason(name: string) {
  return OMIT_RULES.find(([, re]) => re.test(name))?.[0];
}

describe('the export register', () => {
  it('names every person link: exported, withheld with a reason, already covered, or not a person', () => {
    const exported = new Set(EXPORT_REGISTER.flatMap((e) => e.by.map((b) => `${e.model}.${b}`)));
    const categories = new Set(EXPORT_REGISTER.map((e) => e.category));
    const unclassified = personLinks().filter((l) => !exported.has(l) && !WITHHELD[l] && !ALSO_COVERED[l] && !NOT_A_PERSON[l]);
    expect(unclassified).toEqual([]);
    for (const [link, category] of Object.entries(ALSO_COVERED)) expect(categories.has(category), link).toBe(true);
    // Nothing classified that does not exist (a stale entry hides a renamed column).
    const known = new Set(personLinks());
    const stale = [...Object.keys(WITHHELD), ...Object.keys(ALSO_COVERED), ...Object.keys(NOT_A_PERSON)].filter((l) => !known.has(l));
    expect(stale).toEqual([]);
  });

  it('classifies every column of every exported table, and exports no secret, file pointer or safety signal', () => {
    const problems: string[] = [];
    for (const e of EXPORT_REGISTER) {
      const m = byName.get(e.model);
      if (!m) { problems.push(`${e.category}: no model ${e.model}`); continue; }
      const columns = m.fields.filter((f) => f.kind !== 'object');
      const names = new Set(columns.map((f) => f.name));
      for (const f of [...e.fields, ...e.by, e.key]) if (!names.has(f)) problems.push(`${e.category}: no column ${f}`);
      for (const b of e.by) if (!e.fields.includes(b)) problems.push(`${e.category}: by column ${b} not exported`);
      for (const f of columns) {
        const exported = e.fields.includes(f.name);
        const reason = e.omit?.[f.name] ?? (f.type === 'Bytes' ? 'SECRET' : ruleReason(f.name)) ?? e.rest;
        if (!exported && !reason) problems.push(`${e.category}: column ${f.name} is neither exported nor left out for a reason`);
        if (exported && !e.by.includes(f.name) && (f.type === 'Bytes' || ['SECRET', 'STORED_FILE', 'FRAUD_SAFETY'].includes(ruleReason(f.name) ?? ''))) {
          problems.push(`${e.category}: exports ${f.name}, which the rules keep out`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('classifies every column of the account row', () => {
    const user = byName.get('User')!;
    const problems = user.fields.filter((f) => f.kind !== 'object').filter((f) => {
      const exported = (ACCOUNT_FIELDS as readonly string[]).includes(f.name);
      const reason = ruleReason(f.name);
      return exported ? ['SECRET', 'STORED_FILE', 'FRAUD_SAFETY'].includes(reason ?? '') : !reason;
    }).map((f) => f.name);
    expect(problems).toEqual([]);
    for (const f of ACCOUNT_FIELDS) expect(user.fields.some((c) => c.name === f), f).toBe(true);
  });

  it('gives every category one name, and every entry a reader', () => {
    const names = EXPORT_REGISTER.map((e) => e.category);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['addresses', 'orders', 'ratingsGiven', 'serviceJobs'])); // the keys build 9-12 phones already share
  });
});
