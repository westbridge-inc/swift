import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { cartMergeSchema } from '../modules/user/cart-merge.service';

// [DEP-ZOD · GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404] Before zod 4.6.6 an array's
// `.max()` was checked only AFTER every element had been parsed, and every
// failing element added its own issues. So `.max(100)` bounded nothing: a
// 1 MB JSON body of empty objects sent to a bounded list of 5-field lines
// built about a million issue objects before the size was ever looked at.
// From 4.6.6 the size bound is checked first and an oversized list is refused
// with ONE issue, without parsing a single element.

/** Up to 1 MiB of `{}` elements: what fastify's default body limit admits. */
const OVERSIZED = 200_000;

describe('an oversized bounded list is refused on its size, before any element is parsed', () => {
  it('a real API schema: a basket upload of 200k empty lines (cap 100) gives ONE too_big issue', () => {
    const lines = Array.from({ length: OVERSIZED }, () => ({}));
    const result = cartMergeSchema.safeParse({ lines });
    expect(result.success).toBe(false);
    expect(result.error!.issues).toHaveLength(1);
    expect(result.error!.issues[0]).toMatchObject({
      code: 'too_big',
      path: ['lines'],
      message: 'Array must contain at most 100 element(s)',
    });
  });

  it('the element schema never runs on an oversized list', () => {
    let elementChecks = 0;
    const element = z.string().refine(() => {
      elementChecks += 1;
      return true;
    });
    const result = z.array(element).max(10).safeParse(Array.from({ length: OVERSIZED }, () => 'x'));
    expect(result.success).toBe(false);
    expect(result.error!.issues).toHaveLength(1);
    expect(elementChecks).toBe(0);
  });

  it('a list within its bound is still parsed element by element', () => {
    let elementChecks = 0;
    const element = z.string().refine(() => {
      elementChecks += 1;
      return true;
    });
    expect(z.array(element).max(10).safeParse(['a', 'b', 'c']).success).toBe(true);
    expect(elementChecks).toBe(3);
  });

  it('the installed zod is a fixed release (>= 4.6.6)', () => {
    const pkg = JSON.parse(readFileSync(require.resolve('zod/package.json'), 'utf8')) as { version: string };
    const [major, minor, patch] = pkg.version.split('.').map((n) => Number.parseInt(n, 10));
    const fixed = major! > 4 || (major === 4 && (minor! > 6 || (minor === 6 && patch! >= 6)));
    expect({ version: pkg.version, fixed }).toEqual({ version: pkg.version, fixed: true });
  });
});
