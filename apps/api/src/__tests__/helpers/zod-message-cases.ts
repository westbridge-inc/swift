/**
 * Validation cases whose 400 wording clients read (error.details[<field>]).
 * Each case is a schema built with the zod the caller passes in, the way the
 * API's routes build theirs, and an input that fails it in one specific way.
 *
 * zod-v3-messages.unit.test.ts runs them through the API's zod (src/lib/zod)
 * and compares against the details zod 3.25.76 produced for the very same
 * cases (recorded before the zod 4 move). Takes `z` as a parameter so the
 * recording could run the same file against zod 3.
 */
import type { z as Z } from 'zod';

export interface MessageCase {
  name: string;
  schema: Z.ZodType;
  input: unknown;
}

export function buildMessageCases(z: typeof Z): MessageCase[] {
  const Role = { CUSTOMER: 'CUSTOMER', VENDOR: 'VENDOR' } as const;
  const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
  return [
    { name: 'missing required string', schema: z.object({ name: z.string().trim().min(1).max(100) }), input: {} },
    { name: 'string given a number', schema: z.object({ name: z.string() }), input: { name: 5 } },
    { name: 'number given a string', schema: z.object({ amount: z.number() }), input: { amount: '5' } },
    { name: 'number given null', schema: z.object({ amount: z.number() }), input: { amount: null } },
    { name: 'coerced number from text', schema: z.object({ limit: z.coerce.number().int().min(1).max(50) }), input: { limit: 'abc' } },
    { name: 'empty after trim', schema: z.object({ label: z.string().trim().min(1).max(50) }), input: { label: '   ' } },
    { name: 'string too long', schema: z.object({ note: z.string().max(5) }), input: { note: 'abcdefgh' } },
    { name: 'string exact length', schema: z.object({ code: z.string().length(6) }), input: { code: '123' } },
    { name: 'number above max', schema: point, input: { lat: 91, lng: 0 } },
    { name: 'number below min', schema: point, input: { lat: 0, lng: -181 } },
    { name: 'positive', schema: z.object({ amount: z.number().positive() }), input: { amount: 0 } },
    { name: 'nonnegative', schema: z.object({ amount: z.number().nonnegative() }), input: { amount: -1 } },
    { name: 'gt / lt', schema: z.object({ a: z.number().gt(1), b: z.number().lt(1) }), input: { a: 1, b: 1 } },
    { name: 'int given a float', schema: z.object({ quantity: z.number().int().min(1).max(99) }), input: { quantity: 1.5 } },
    { name: 'NaN', schema: z.object({ lng: z.number() }), input: { lng: Number.NaN } },
    { name: 'boolean given text', schema: z.object({ isActive: z.boolean() }), input: { isActive: 'yes' } },
    { name: 'object given an array', schema: z.object({ pickup: point }), input: { pickup: [1, 2] } },
    { name: 'object given null', schema: z.object({ pickup: point }), input: { pickup: null } },
    { name: 'array given an object', schema: z.object({ tags: z.array(z.string()) }), input: { tags: { a: 1 } } },
    { name: 'enum: unknown text', schema: z.object({ fulfillment: z.enum(['DELIVERY', 'PICKUP']) }), input: { fulfillment: 'DRONE' } },
    { name: 'enum: a number', schema: z.object({ fulfillment: z.enum(['DELIVERY', 'PICKUP']) }), input: { fulfillment: 3 } },
    { name: 'enum: missing', schema: z.object({ fulfillment: z.enum(['DELIVERY', 'PICKUP']) }), input: {} },
    { name: 'nativeEnum: unknown text', schema: z.object({ role: z.nativeEnum(Role) }), input: { role: 'ADMIN' } },
    { name: 'literal true', schema: z.object({ verifiedInPortal: z.literal(true) }), input: { verifiedInPortal: false } },
    { name: 'literal missing', schema: z.object({ verifiedInPortal: z.literal(true) }), input: {} },
    { name: 'email', schema: z.object({ email: z.string().email() }), input: { email: 'not-an-email' } },
    { name: 'url', schema: z.object({ website: z.string().url() }), input: { website: 'not a url' } },
    { name: 'datetime', schema: z.object({ paidAt: z.string().datetime() }), input: { paidAt: '2026-10-24 10:00' } },
    { name: 'regex without message', schema: z.object({ slug: z.string().regex(/^[a-z]+$/) }), input: { slug: 'A1' } },
    { name: 'regex with message', schema: z.object({ slug: z.string().regex(/^[a-z]+$/, 'A slug is lowercase letters') }), input: { slug: 'A1' } },
    { name: 'own message on min', schema: z.object({ reason: z.string().min(3, 'Say why (3+ characters)') }), input: { reason: 'x' } },
    { name: 'coerced date from text', schema: z.object({ from: z.coerce.date() }), input: { from: 'not a date' } },
    { name: 'coerced number missing', schema: z.object({ lat: z.coerce.number().min(-90).max(90) }), input: {} },
    { name: 'coerced date missing', schema: z.object({ slotStart: z.coerce.date() }), input: {} },
    { name: 'strict: unknown keys', schema: z.object({ a: z.string() }).strict(), input: { a: 'x', b: 1, c: 2 } },
    { name: 'array above max', schema: z.object({ ids: z.array(z.string()).max(2) }), input: { ids: ['a', 'b', 'c'] } },
    { name: 'array below min', schema: z.object({ ids: z.array(z.string()).min(1) }), input: { ids: [] } },
    { name: 'array element errors', schema: z.object({ ids: z.array(z.string().min(2)).max(5) }), input: { ids: ['ok', 'x', 7] } },
    { name: 'union of number and text', schema: z.object({ amount: z.union([z.number(), z.string()]) }), input: { amount: true } },
    { name: 'optional-or-empty url', schema: z.object({ website: z.string().trim().url().max(200).optional().or(z.literal('')) }), input: { website: 'nope' } },
    { name: 'record of enum', schema: z.object({ sel: z.record(z.string(), z.enum(['DELIVERY', 'PICKUP'])) }), input: { sel: { v1: 'DELIVERY', v2: 'BOAT' } } },
    { name: 'record key too long', schema: z.object({ params: z.record(z.string().max(3), z.string()) }), input: { params: { abcdef: 'x' } } },
    { name: 'refine without message', schema: z.object({ n: z.number().refine((v) => v % 2 === 0) }), input: { n: 3 } },
    { name: 'refine with message', schema: z.object({ n: z.number().refine((v) => v % 2 === 0, 'Must be even') }), input: { n: 3 } },
    {
      name: 'object refine with path',
      schema: z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, { message: 'a must be below b', path: ['b'] }),
      input: { a: 2, b: 1 },
    },
    {
      name: 'superRefine custom issue',
      schema: z.object({ lines: z.array(z.string()).max(3) }).superRefine((v, ctx) => {
        if (new Set(v.lines).size !== v.lines.length) ctx.addIssue({ code: 'custom', message: 'Each line needs its own identifier.' });
      }),
      input: { lines: ['a', 'a'] },
    },
    { name: 'nested path', schema: z.object({ stops: z.array(point.extend({ address: z.string().trim().min(3).max(200) })) }), input: { stops: [{ lat: 0, lng: 0, address: 'ab' }] } },
    { name: 'several fields at once', schema: z.object({ name: z.string().min(1), age: z.number().int(), kind: z.enum(['A', 'B']) }), input: { name: '', age: 'x', kind: 'C' } },
  ];
}

/** The wire shape the error handler builds from a ZodError (details by joined path). */
export function detailsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join('.');
    (details[path] ??= []).push(issue.message);
  }
  return details;
}
