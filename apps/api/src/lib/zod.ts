/**
 * The ONE place the API imports zod from (pinned by zod-v3-messages.unit.test.ts).
 *
 * Why it exists: the API moved from zod 3 to zod 4 for a memory-exhaustion fix
 * (GHSA-mrhx-c7xc-m3w5: zod before 4.6.6 checked an array's `.max()` only after
 * parsing every element, so a bound bounded nothing). Zod 4 also rewrote its
 * default English messages ("Required" became "Invalid input: expected string,
 * received undefined", and so on). Those messages are part of our API: the
 * error handler returns them in `error.details[<field>]` on every 400, and the
 * phone, web and admin clients show or match them. So this module installs a
 * global zod error map that renders every issue a schema raises WITHOUT its own
 * message in the exact zod 3 default wording (copied from zod 3.25.76's
 * v3/locales/en.js). A message a schema sets itself still wins, as before.
 *
 * Importing `z` from here (not from 'zod') guarantees the map is installed
 * before any of our schemas parses anything.
 */
import { z } from 'zod';

type Issue = z.core.$ZodRawIssue;

/** zod 3's ZodParsedType for a raw input (v3/helpers/util.js getParsedType). */
function v3ParsedType(data: unknown): string {
  switch (typeof data) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return 'string';
    case 'number':
      return Number.isNaN(data) ? 'nan' : 'number';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'object': {
      if (Array.isArray(data)) return 'array';
      if (data === null) return 'null';
      const maybe = data as { then?: unknown; catch?: unknown };
      if (typeof maybe.then === 'function' && typeof maybe.catch === 'function') return 'promise';
      if (data instanceof Map) return 'map';
      if (data instanceof Set) return 'set';
      if (data instanceof Date) return 'date';
      return 'object';
    }
    default:
      return 'unknown';
  }
}

/** zod 3's util.joinValues: strings quoted with ', joined by ' | ' (or the separator). */
function joinValues(values: readonly unknown[], separator = ' | '): string {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(separator);
}

function jsonStringifyReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** zod 4's names for an expected type, in zod 3's words. */
const V3_EXPECTED: Record<string, string> = { record: 'object', tuple: 'array' };

/** zod 4 string formats in zod 3's `invalid_string` validation names. */
const V3_VALIDATION: Record<string, string> = {
  ipv4: 'ip',
  ipv6: 'ip',
  cidrv4: 'cidr',
  cidrv6: 'cidr',
  guid: 'uuid',
  uuidv4: 'uuid',
  uuidv6: 'uuid',
  uuidv7: 'uuid',
};

/** zod 4 size origins in zod 3's `type` words (zod 4 says 'int' for .int()). */
function v3SizeType(origin: unknown): string {
  return origin === 'int' ? 'number' : String(origin);
}

function isLiteralSchema(issue: Issue): boolean {
  const def = (issue.inst as { _zod?: { def?: { type?: unknown } } } | undefined)?._zod?.def;
  return def?.type === 'literal';
}

/**
 * The message zod 3 would have given this issue by default (zod 3.25.76
 * v3/locales/en.js), or undefined to fall through to zod's own locale.
 */
export function v3DefaultMessage(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'invalid_type': {
      // zod 4 flags a missing key whose schema accepts undefined as
      // 'nonoptional'; zod 3 called every absent required value "Required".
      if (issue.input === undefined || issue.expected === 'nonoptional') return 'Required';
      // .int() on a non-integer: zod 3 said integer / float.
      if (issue.expected === 'int') return 'Expected integer, received float';
      // zod 4 refuses an Invalid Date with invalid_type; zod 3 had its own code.
      if (issue.expected === 'date' && issue.input instanceof Date) return 'Invalid date';
      // zod 4 refuses ±Infinity as a number; zod 3's nearest words.
      if (issue.expected === 'number' && typeof issue.input === 'number' && !Number.isNaN(issue.input)) {
        return 'Number must be finite';
      }
      const expected = V3_EXPECTED[issue.expected] ?? issue.expected;
      return `Expected ${expected}, received ${v3ParsedType(issue.input)}`;
    }
    case 'invalid_value': {
      // zod 4 folds z.literal and z.enum / z.nativeEnum into one code.
      if (isLiteralSchema(issue)) {
        const expected = issue.values.length === 1 ? issue.values[0] : issue.values;
        return `Invalid literal value, expected ${JSON.stringify(expected, jsonStringifyReplacer)}`;
      }
      if (issue.input === undefined) return 'Required';
      if (typeof issue.input !== 'string') {
        return `Expected ${joinValues(issue.values)}, received ${v3ParsedType(issue.input)}`;
      }
      return `Invalid enum value. Expected ${joinValues(issue.values)}, received '${issue.input}'`;
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(issue.keys, ', ')}`;
    case 'invalid_union':
      return 'Invalid input';
    case 'invalid_format': {
      const format = issue.format;
      if (format === 'includes') {
        const inc = issue as typeof issue & { includes?: string; position?: number };
        let message = `Invalid input: must include "${inc.includes}"`;
        if (typeof inc.position === 'number') {
          message = `${message} at one or more positions greater than or equal to ${inc.position}`;
        }
        return message;
      }
      if (format === 'starts_with') return `Invalid input: must start with "${(issue as { prefix?: string }).prefix}"`;
      if (format === 'ends_with') return `Invalid input: must end with "${(issue as { suffix?: string }).suffix}"`;
      if (format === 'regex') return 'Invalid';
      return `Invalid ${V3_VALIDATION[format] ?? format}`;
    }
    case 'too_small': {
      const type = v3SizeType(issue.origin);
      const min = issue.minimum;
      if (type === 'array') {
        return `Array must contain ${issue.exact ? 'exactly' : issue.inclusive ? 'at least' : 'more than'} ${min} element(s)`;
      }
      if (type === 'string') {
        return `String must contain ${issue.exact ? 'exactly' : issue.inclusive ? 'at least' : 'over'} ${min} character(s)`;
      }
      if (type === 'number' || type === 'bigint') {
        return `Number must be ${issue.exact ? 'exactly equal to ' : issue.inclusive ? 'greater than or equal to ' : 'greater than '}${min}`;
      }
      if (type === 'date') {
        return `Date must be ${issue.exact ? 'exactly equal to ' : issue.inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(min))}`;
      }
      return 'Invalid input';
    }
    case 'too_big': {
      const type = v3SizeType(issue.origin);
      const max = issue.maximum;
      if (type === 'array') {
        return `Array must contain ${issue.exact ? 'exactly' : issue.inclusive ? 'at most' : 'less than'} ${max} element(s)`;
      }
      if (type === 'string') {
        return `String must contain ${issue.exact ? 'exactly' : issue.inclusive ? 'at most' : 'under'} ${max} character(s)`;
      }
      if (type === 'number') {
        return `Number must be ${issue.exact ? 'exactly' : issue.inclusive ? 'less than or equal to' : 'less than'} ${max}`;
      }
      if (type === 'bigint') {
        return `BigInt must be ${issue.exact ? 'exactly' : issue.inclusive ? 'less than or equal to' : 'less than'} ${max}`;
      }
      if (type === 'date') {
        return `Date must be ${issue.exact ? 'exactly' : issue.inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(max))}`;
      }
      return 'Invalid input';
    }
    case 'custom':
      return 'Invalid input';
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`;
    case 'invalid_key':
    case 'invalid_element': {
      // zod 3 reported a bad record key with the key schema's own issue.
      const first = issue.issues[0];
      return first?.message ?? 'Invalid input';
    }
    default:
      return undefined;
  }
}

z.config({ customError: (issue) => v3DefaultMessage(issue) });

export { z, ZodError } from 'zod';
