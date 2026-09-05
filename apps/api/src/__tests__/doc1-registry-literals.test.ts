/**
 * [DOC-1 §4.2 · DOC-INV-2] "fails the build if any code path hard-codes a
 * document type string outside the registry seed."
 *
 * Until the registry is ACTIVE, the country checklist JSON
 * (ops/platform-config.ts) is the source of truth and the seed
 * (verification/doc-registry.ts) derives from it — both are the registry's
 * own text. Every OTHER quoted document-type literal in the API is a
 * hard-coded fact that should one day be a registry attribute (which document
 * is face-matched; which the compliance capture allows). This is a RATCHET:
 * the set of such sites equals a checked-in register that only shrinks.
 *
 * Known interim, deliberately outside this census: the keys of
 * AUTO_APPROVE_EXPIRY_DAYS are unquoted object keys — a second registry of
 * expiry facts that the seed already derives from, and that retires into
 * doc_type.has_expiry / default_validity_days when the registry activates.
 * Mobile and web sites are surface work for the Opus queue.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BUCKET_OF } from '../modules/verification/doc-registry';

const API_SRC = join(__dirname, '..');
/** The registry's own text: the JSON source of the checklists, and the seed that derives from it. */
const REGISTRY_TEXT = new Set(['modules/ops/platform-config.ts', 'modules/verification/doc-registry.ts']);
/** Hard-coded document type sites, as `file → literals`. Move a fact into the registry, then remove it here. */
export const HARD_CODED_DOC_TYPES: Record<string, readonly string[]> = {
  // the compliance capture allowlist names the selfie field
  'modules/compliance/capture-allowlists.ts': ['selfie'],
  // which identity documents are face-matched; the L2 identity leg's doc type;
  // the insurance five-point review's doc type
  'modules/verification/verification.service.ts': ['national_id', 'owner_national_id', 'vehicle_insurance'],
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!['__tests__', 'node_modules'].includes(name)) walk(p, out); continue; }
    if (p.endsWith('.ts')) out.push(p);
  }
  return out;
};

describe('[DOC-INV-2] document type strings live in the registry, not in code', () => {
  it('the census is not vacuous', () => {
    expect(Object.keys(BUCKET_OF).length).toBeGreaterThan(10);
  });

  it('every quoted document-type literal outside the registry’s own text is in the register — which only shrinks', () => {
    const codes = Object.keys(BUCKET_OF);
    const re = new RegExp(`'(${codes.join('|')})'`, 'g');
    const found: Record<string, string[]> = {};
    for (const f of walk(API_SRC)) {
      const rel = relative(API_SRC, f);
      if (REGISTRY_TEXT.has(rel)) continue;
      const src = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      const hits = [...new Set([...src.matchAll(re)].map((m) => m[1]!))].sort();
      if (hits.length) found[rel] = hits;
    }
    const expected = Object.fromEntries(Object.entries(HARD_CODED_DOC_TYPES).map(([k, v]) => [k, [...v].sort()]));
    expect(found).toEqual(expected);
  });

  it('the register names only files that exist', () => {
    for (const rel of Object.keys(HARD_CODED_DOC_TYPES)) expect(statSync(join(API_SRC, rel)).isFile()).toBe(true);
  });
});
