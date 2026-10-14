import { project, type Row } from './service-vertical-doubles';

// Only service-free predicate evaluation. This does not model SQL/RLS or locks.
export type Query = { where?: Row; select?: Row; include?: Row };
const operators = new Set(['equals', 'in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'is', 'isNot', 'every', 'some', 'none', 'contains', 'mode', 'has', 'hasSome']);
export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (['AND', 'OR', 'NOT'].includes(key)) {
      const clauses = Array.isArray(condition) ? condition : [condition];
      const outcomes = clauses.map(c => matches(row, c as Row));
      return key === 'AND' ? outcomes.every(Boolean) : key === 'OR' ? outcomes.some(Boolean) : !outcomes.some(Boolean);
    }
    if (!(key in row)) throw new Error(`UNMODELLED_COLUMN:${key}`);
    const value = row[key];
    if (condition === null || typeof condition !== 'object' || condition instanceof Date) return value === condition;
    const entries = Object.entries(condition as Row);
    if (!entries.some(([op]) => operators.has(op))) return value !== null && matches(value as Row, condition as Row);
    return entries.every(([op, bound]) => {
      if (op === 'equals') return value === bound;
      if (op === 'in') return (bound as unknown[]).includes(value);
      if (op === 'notIn') return !(bound as unknown[]).includes(value);
      if (op === 'not') return value !== bound;
      if (op === 'is') return bound === null ? value === null : value != null && matches(value as Row, bound as Row);
      if (op === 'isNot') return bound === null ? value !== null : value === null || !matches(value as Row, bound as Row);
      if (op === 'every') return (value as Row[]).every(r => matches(r, bound as Row));
      if (op === 'some') return (value as Row[]).some(r => matches(r, bound as Row));
      if (op === 'none') return !(value as Row[]).some(r => matches(r, bound as Row));
      if (op === 'mode') return true;
      if (op === 'contains') return String(value).toLowerCase().includes(String(bound).toLowerCase());
      if (op === 'has') return (value as unknown[]).includes(bound);
      if (op === 'hasSome') return (bound as unknown[]).some(v => (value as unknown[]).includes(v));
      if (value == null || bound == null) return false;
      const a = value instanceof Date ? value.getTime() : Number(value);
      const b = bound instanceof Date ? bound.getTime() : Number(bound);
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      if (op === 'lte') return a <= b;
      throw new Error(`UNMODELLED_OPERATOR:${op}`);
    });
  });
}


export function queryRow(row: Row, query: Query = {}): Row | null {
  if (!matches(row, query.where)) return null;
  const result = project(row, query.select);
  for (const [key, value] of Object.entries(query.include ?? query.select ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const nested = value as Query;
    const relation = row[key];
    if (Array.isArray(relation)) result[key] = relation.map(r => queryRow(r as Row, nested)).filter(r => r !== null);
    else if (relation != null) result[key] = queryRow(relation as Row, nested);
  }
  return result;
}
