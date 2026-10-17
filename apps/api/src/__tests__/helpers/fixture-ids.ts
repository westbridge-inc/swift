import { customAlphabet } from 'nanoid';

/**
 * [VERIFY row 302 · flake class 3] Fixture tags that are VALID BY CONSTRUCTION.
 *
 * `nanoid()` draws from `A-Za-z0-9_-`. A fixture id or reference built from it
 * fails any stricter pattern at random — e.g. the fee-receipt route's
 * `^[A-Z0-9-]{1,64}$` rejects `_`, which a six-character nanoid holds
 * 1 - (63/64)^6 = 8.96% of the time — and the suite reds with a 400 it never
 * meant to test. `fixtureTag()` draws only from `0-9a-z`, which every id, slug
 * and (upper-cased) reference pattern of the API accepts.
 */
const tagAlphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz');

/** A random tag of `0-9a-z` (default 8 characters): valid in every id, slug and upper-cased reference pattern. */
export function fixtureTag(length = 8): string {
  return tagAlphabet(length);
}
