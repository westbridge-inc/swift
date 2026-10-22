/**
 * [Row 331 · DSAR-ERASURE (b)] The export register covers every person link and every column.
 * Reads the generated schema (Prisma DMMF), so a new table or column that points at a person,
 * or a new column on an exported table, is red here until someone decides: export it, or say why not.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { ACCOUNT_FIELDS, ALSO_COVERED, EXPORT_REGISTER, NOT_A_PERSON, OMIT_REASON_TEXT, OMIT_RULES, PLACES_NOT_EXPORTED, WITHHELD, WITHHELD_REASON_TEXT, type OmitReason } from '../modules/user/data-export-register';
import { EXPORT_NOTICE, OMIT_REASONS_IN_USE } from '../modules/user/data-export';
import { personLinks } from './helpers/person-links';

const models = Prisma.dmmf.datamodel.models;
const byName = new Map(models.map((m) => [m.name, m]));

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
      for (const f of [...e.fields, e.key]) if (!names.has(f)) problems.push(`${e.category}: no column ${f}`);
      if (e.through) {
        // A child table read through its parent: the `by` columns are the parent's, and the parent is itself
        // exported to the person by exactly those columns (the stops go to whoever gets the ride, no one else).
        const parent = m.fields.find((f) => f.kind === 'object' && f.name === e.through && (f.relationFromFields ?? []).length > 0);
        const parentColumns = new Set((parent && byName.get(parent.type)?.fields.filter((f) => f.kind !== 'object').map((f) => f.name)) ?? []);
        if (!parent) problems.push(`${e.category}: no parent relation ${e.through}`);
        for (const b of e.by) if (!parentColumns.has(b)) problems.push(`${e.category}: no parent column ${b}`);
        if (parent && !EXPORT_REGISTER.some((p) => !p.through && !p.via && !p.rest && !p.where && p.model === parent.type && e.by.every((b) => p.by.includes(b)))) {
          problems.push(`${e.category}: its ${parent.type} is not exported to the person by ${e.by.join(', ')}`);
        }
      } else {
        for (const b of e.by) if (!names.has(b)) problems.push(`${e.category}: no column ${b}`);
        for (const b of e.by) if (!e.fields.includes(b)) problems.push(`${e.category}: by column ${b} not exported`);
      }
      for (const f of columns) {
        const exported = e.fields.includes(f.name);
        const reason = e.omit?.[f.name] ?? (f.type === 'Bytes' ? 'SECRET' : ruleReason(f.name)) ?? e.rest;
        if (!exported && !reason) problems.push(`${e.category}: column ${f.name} is neither exported nor left out for a reason`);
        if (exported && !e.by.includes(f.name) && (f.type === 'Bytes' || ['SECRET', 'STORED_FILE', 'FRAUD_SAFETY', 'RATING_TOTAL'].includes(ruleReason(f.name) ?? ''))) {
          problems.push(`${e.category}: exports ${f.name}, which the rules keep out`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives the places on a child table of the person’s own record with that record (REVIEW-M S3-1: a taxi ride’s stops)', () => {
    // A child table with no person column of its own is invisible to the person-link census above, so a place
    // it holds (an address or a coordinate) would quietly stay out of the file. Each one is exported `through`
    // its parent (or this list names why not).
    const own = new Set(EXPORT_REGISTER.filter((e) => !e.through && !e.via && !e.rest).map((e) => e.model));
    const linked = new Set(personLinks().map((l) => l.split('.')[0]));
    const through = new Set(EXPORT_REGISTER.filter((e) => e.through).map((e) => e.model));
    const PLACE = /^(lat|lng|latitude|longitude|address)$|(Lat|Lng|Latitude|Longitude|Address)$/;
    const candidates = models
      .filter((m) => !linked.has(m.name) && m.fields.some((f) => f.kind === 'object' && own.has(f.type) && (f.relationFromFields ?? []).length > 0))
      .filter((m) => m.fields.some((f) => f.kind === 'scalar' && PLACE.test(f.name)))
      .map((m) => m.name);
    const missing = candidates.filter((name) => !through.has(name) && !PLACES_NOT_EXPORTED[name]);
    expect(missing).toEqual([]);
    // Nothing named that the rule would not list (a stale entry hides a renamed table), nor both exported and named.
    expect(Object.keys(PLACES_NOT_EXPORTED).filter((name) => !candidates.includes(name) || through.has(name))).toEqual([]);
  });

  it('classifies every column of the account row', () => {
    const user = byName.get('User')!;
    const problems = user.fields.filter((f) => f.kind !== 'object').filter((f) => {
      const exported = (ACCOUNT_FIELDS as readonly string[]).includes(f.name);
      const reason = ruleReason(f.name);
      return exported ? ['SECRET', 'STORED_FILE', 'FRAUD_SAFETY', 'RATING_TOTAL'].includes(reason ?? '') : !reason;
    }).map((f) => f.name);
    expect(problems).toEqual([]);
    for (const f of ACCOUNT_FIELDS) expect(user.fields.some((c) => c.name === f), f).toBe(true);
  });

  it('says exactly what the code leaves out: the notice names every column rule in use, and only those', () => {
    const used = new Set<OmitReason>(OMIT_RULES.map(([r]) => r));
    for (const e of EXPORT_REGISTER) { for (const r of Object.values(e.omit ?? {})) used.add(r); if (e.rest) used.add(e.rest); }
    expect([...OMIT_REASONS_IN_USE].sort()).toEqual([...used].sort());
    for (const r of Object.keys(OMIT_REASON_TEXT) as OmitReason[]) {
      if (used.has(r)) expect(EXPORT_NOTICE, r).toContain(OMIT_REASON_TEXT[r]);
      else expect(EXPORT_NOTICE, r).not.toContain(OMIT_REASON_TEXT[r]);
    }
    for (const w of Object.values(WITHHELD)) expect(WITHHELD_REASON_TEXT[w.reason]).toBeTruthy();
  });

  it('gives every category one name, and every entry a reader', () => {
    const names = EXPORT_REGISTER.map((e) => e.category);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['addresses', 'orders', 'ratingsGiven', 'serviceJobs'])); // the keys build 9-12 phones already share
  });
});
