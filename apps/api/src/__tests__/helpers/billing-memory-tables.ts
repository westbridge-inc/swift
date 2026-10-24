import { vi } from 'vitest';
import { Prisma } from '@prisma/client';

type Row = Record<string, any>;
const scalar = (v: any) => v instanceof Date ? v.getTime() : v;

export function cloneBillingValue<T>(value: T): T {
  if (Prisma.Decimal.isDecimal(value)) return Number(value) as T;
  if (value instanceof Date) return new Date(value) as T;
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, cloneBillingValue(v)])) as T;
  if (value instanceof Set) return new Set([...value].map(cloneBillingValue)) as T;
  if (Array.isArray(value)) return value.map(cloneBillingValue) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneBillingValue(v)])) as T;
  // Fixture wall clocks are callbacks, not stored database values. Rollback
  // preserves the same independent clock rather than trying to clone code.
  return value;
}

/** Deterministic table storage for service tests. Production authority, clock,
 * source discovery and resolution functions execute unchanged. PostgreSQL
 * suites own FK/RLS/locking proof; this adapter never claims those guarantees. */
export function matchesBillingRow(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, wanted]) => {
    if (wanted === undefined) return true;
    if (key === 'AND') return (Array.isArray(wanted) ? wanted : [wanted]).every((w) => matchesBillingRow(row, w));
    if (key === 'OR') return wanted.some((w: Row) => matchesBillingRow(row, w));
    if (key === 'NOT') return !(Array.isArray(wanted) ? wanted : [wanted]).every((w) => matchesBillingRow(row, w));
    const value = row[key];
    if (wanted === null || typeof wanted !== 'object' || wanted instanceof Date) return scalar(value) === scalar(wanted);
    if ('path' in wanted) return wanted.path.reduce((v: any, p: string) => v?.[p], value) === wanted.equals;
    if ('in' in wanted && !wanted.in.some((v: any) => scalar(value) === scalar(v))) return false;
    if ('notIn' in wanted && wanted.notIn.some((v: any) => scalar(value) === scalar(v))) return false;
    if ('not' in wanted && matchesBillingRow({ value }, { value: wanted.not })) return false;
    if ('equals' in wanted && scalar(value) !== scalar(wanted.equals)) return false;
    if ('startsWith' in wanted && !String(value ?? '').startsWith(wanted.startsWith)) return false;
    if ('gt' in wanted && !(scalar(value) > scalar(wanted.gt))) return false;
    if ('gte' in wanted && !(scalar(value) >= scalar(wanted.gte))) return false;
    if ('lt' in wanted && !(scalar(value) < scalar(wanted.lt))) return false;
    if ('lte' in wanted && !(scalar(value) <= scalar(wanted.lte))) return false;
    const operators = new Set(['in', 'notIn', 'not', 'equals', 'startsWith', 'gt', 'gte', 'lt', 'lte']);
    if (Object.keys(wanted).some((k) => operators.has(k))) return true;
    // Compound unique keys and nested relations retain every constituent.
    return matchesBillingRow(value ?? row, wanted);
  });
}

export function billingMemoryTable(rows: () => Row[], prefix: string, defaults: () => Row = () => ({})) {
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment;
      else row[key] = cloneBillingValue(value);
    }
    return cloneBillingValue(row);
  };
  const find = ({ where = {} }: Row = {}) => rows().find((r) => matchesBillingRow(r, where));
  const many = ({ where = {}, orderBy, take }: Row = {}) => {
    let selected = rows().filter((r) => matchesBillingRow(r, where));
    if (orderBy) for (const [key, direction] of Object.entries(orderBy).reverse()) selected = selected.sort((a, b) =>
      (scalar(a[key]) < scalar(b[key]) ? -1 : scalar(a[key]) > scalar(b[key]) ? 1 : 0) * (direction === 'desc' ? -1 : 1));
    return cloneBillingValue(take ? selected.slice(0, take) : selected);
  };
  const create = ({ data }: Row) => {
    const row = { id: `${prefix}-${rows().length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...cloneBillingValue(data) };
    rows().push(row); return cloneBillingValue(row);
  };
  return {
    findUnique: vi.fn(async (args: Row) => cloneBillingValue(find(args) ?? null)),
    findUniqueOrThrow: vi.fn(async (args: Row) => { const row = find(args); if (!row) throw new Error(`${prefix} row missing`); return cloneBillingValue(row); }),
    findFirst: vi.fn(async (args: Row = {}) => many(args)[0] ?? null),
    findMany: vi.fn(async (args: Row = {}) => many(args)),
    count: vi.fn(async (args: Row = {}) => many(args).length),
    create: vi.fn(async (args: Row) => create(args)),
    createMany: vi.fn(async ({ data, skipDuplicates }: Row) => {
      let count = 0;
      for (const row of data) {
        if (skipDuplicates && rows().some((r) => r['subscriptionId'] === row.subscriptionId)) continue;
        create({ data: row }); count++;
      }
      return { count };
    }),
    update: vi.fn(async ({ where, data }: Row) => { const row = find({ where }); if (!row) throw new Error(`${prefix} update missing`); return apply(row, data); }),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      const selected = rows().filter((r) => matchesBillingRow(r, where));
      for (const row of selected) apply(row, data);
      return { count: selected.length };
    }),
    upsert: vi.fn(async ({ where, update, create: data }: Row) => { const row = find({ where }); return row ? apply(row, update) : create({ data }); }),
  };
}
