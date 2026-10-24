import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from '../lib/zod';
import { buildMessageCases, detailsOf } from './helpers/zod-message-cases';

// [DEP-ZOD · GHSA-mrhx-c7xc-m3w5] The API moved from zod 3.25.76 to zod 4 for a
// memory-exhaustion fix. A 400's `error.details` carries zod's messages and the
// apps read them, so the move must not change one word. These are the details
// zod 3.25.76 produced for every case in helpers/zod-message-cases.ts, recorded
// by running those same cases through zod 3 before the move. Never re-record
// them from the new zod: that would pin whatever it says instead of what the
// clients were built against.
const ZOD3_DETAILS: Record<string, Record<string, string[]>> = {
  "missing required string": {"name": ["Required"]},
  "string given a number": {"name": ["Expected string, received number"]},
  "number given a string": {"amount": ["Expected number, received string"]},
  "number given null": {"amount": ["Expected number, received null"]},
  "coerced number from text": {"limit": ["Expected number, received nan"]},
  "empty after trim": {"label": ["String must contain at least 1 character(s)"]},
  "string too long": {"note": ["String must contain at most 5 character(s)"]},
  "string exact length": {"code": ["String must contain exactly 6 character(s)"]},
  "number above max": {"lat": ["Number must be less than or equal to 90"]},
  "number below min": {"lng": ["Number must be greater than or equal to -180"]},
  "positive": {"amount": ["Number must be greater than 0"]},
  "nonnegative": {"amount": ["Number must be greater than or equal to 0"]},
  "gt / lt": {"a": ["Number must be greater than 1"], "b": ["Number must be less than 1"]},
  "int given a float": {"quantity": ["Expected integer, received float"]},
  "NaN": {"lng": ["Expected number, received nan"]},
  "boolean given text": {"isActive": ["Expected boolean, received string"]},
  "object given an array": {"pickup": ["Expected object, received array"]},
  "object given null": {"pickup": ["Expected object, received null"]},
  "array given an object": {"tags": ["Expected array, received object"]},
  "enum: unknown text": {"fulfillment": ["Invalid enum value. Expected 'DELIVERY' | 'PICKUP', received 'DRONE'"]},
  "enum: a number": {"fulfillment": ["Expected 'DELIVERY' | 'PICKUP', received number"]},
  "enum: missing": {"fulfillment": ["Required"]},
  "nativeEnum: unknown text": {"role": ["Invalid enum value. Expected 'CUSTOMER' | 'VENDOR', received 'ADMIN'"]},
  "literal true": {"verifiedInPortal": ["Invalid literal value, expected true"]},
  "literal missing": {"verifiedInPortal": ["Invalid literal value, expected true"]},
  "email": {"email": ["Invalid email"]},
  "url": {"website": ["Invalid url"]},
  "datetime": {"paidAt": ["Invalid datetime"]},
  "regex without message": {"slug": ["Invalid"]},
  "regex with message": {"slug": ["A slug is lowercase letters"]},
  "own message on min": {"reason": ["Say why (3+ characters)"]},
  "coerced date from text": {"from": ["Invalid date"]},
  "coerced number missing": {"lat": ["Expected number, received nan"]},
  "coerced date missing": {"slotStart": ["Invalid date"]},
  "strict: unknown keys": {"": ["Unrecognized key(s) in object: 'b', 'c'"]},
  "array above max": {"ids": ["Array must contain at most 2 element(s)"]},
  "array below min": {"ids": ["Array must contain at least 1 element(s)"]},
  "array element errors": {"ids.1": ["String must contain at least 2 character(s)"], "ids.2": ["Expected string, received number"]},
  "union of number and text": {"amount": ["Invalid input"]},
  "optional-or-empty url": {"website": ["Invalid url"]},
  "record of enum": {"sel.v2": ["Invalid enum value. Expected 'DELIVERY' | 'PICKUP', received 'BOAT'"]},
  "record key too long": {"params.abcdef": ["String must contain at most 3 character(s)"]},
  "refine without message": {"n": ["Invalid input"]},
  "refine with message": {"n": ["Must be even"]},
  "object refine with path": {"b": ["a must be below b"]},
  "superRefine custom issue": {"": ["Each line needs its own identifier."]},
  "nested path": {"stops.0.address": ["String must contain at least 3 character(s)"]},
  "several fields at once": {"name": ["String must contain at least 1 character(s)"], "age": ["Expected number, received string"], "kind": ["Invalid enum value. Expected 'A' | 'B', received 'C'"]},
};

describe('zod 4 answers every validation failure in zod 3 words', () => {
  const cases = buildMessageCases(z);

  it('every case has a zod 3 recording, and every recording a case', () => {
    expect(cases.map((c) => c.name).sort()).toEqual(Object.keys(ZOD3_DETAILS).sort());
  });

  for (const c of cases) {
    it(c.name, () => {
      const result = c.schema.safeParse(c.input);
      expect(result.success).toBe(false);
      expect(detailsOf(result.error!.issues)).toEqual(ZOD3_DETAILS[c.name]);
    });
  }

  it('a schema that names its own message still wins over the zod 3 words', () => {
    const r = z.object({ reason: z.string().min(3, 'Say why') }).safeParse({ reason: '' });
    expect(r.error!.issues.map((i) => i.message)).toEqual(['Say why']);
  });

  // zod 4.6 turned a missing key whose schema accepts undefined (z.any(),
  // z.unknown()) into an error; zod 3 let it through. The API's own schemas
  // with such keys mark them optional, so this pins the zod 4 rule the
  // compatibility words rely on ('Required', as zod 3 would have said had it
  // refused).
  it('a missing z.unknown() key reads Required, not zod 4 words', () => {
    const r = z.object({ data: z.unknown() }).safeParse({});
    expect(r.success).toBe(false);
    expect(detailsOf(r.error!.issues)).toEqual({ data: ['Required'] });
  });
});

describe('src/lib/zod is the only way into zod', () => {
  // The zod 3 words above are installed by src/lib/zod. A module that imported
  // 'zod' directly could parse before that ran and answer in zod 4 words.
  it('no API source file imports zod except src/lib/zod.ts', () => {
    const src = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'generated') walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        const rel = relative(src, path);
        if (rel === join('lib', 'zod.ts')) continue;
        if (/from\s+['"]zod(\/[^'"]*)?['"]|require\(\s*['"]zod(\/[^'"]*)?['"]\s*\)|import\(\s*['"]zod(\/[^'"]*)?['"]\s*\)/.test(readFileSync(path, 'utf8'))) offenders.push(rel);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it("nothing in the API reaches zod 3's code through the 'zod/v3' subpath", () => {
    const lib = readFileSync(join(__dirname, '..', 'lib', 'zod.ts'), 'utf8');
    expect(lib).not.toMatch(/['"]zod\/v3['"]/);
    expect(lib).toMatch(/from 'zod';/);
  });
});
