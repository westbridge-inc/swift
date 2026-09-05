/**
 * [DOC-1 §7 · P7-1] Validator implementations, addressed by the registry's
 * implRef. The registry (the `validator` table, seeded from doc-registry.ts)
 * says WHICH validators exist, for which type, whether they block and which
 * §8.5 reason a FAIL carries; this module says HOW the implemented ones judge.
 * A registry row whose implRef does not resolve here is a phantom, and
 * DOC-INV-2 refuses to let an ACTIVE document type depend on one.
 */
import type { ValidationStatus } from '@prisma/client';

export interface DeclaredField { fieldCode: string; isRequired: boolean; isBlindIndexed: boolean }
export interface ValidatorInput {
  declared: readonly DeclaredField[];
  /** field code → value the processor read (declared fields only) */
  present: ReadonlyMap<string, string>;
  collided: boolean;
}
/** A FAIL carries the registry's detailCode; SKIP and WARN may say why here. */
export interface ValidatorVerdict { status: ValidationStatus; detailCode?: string | null }
export type ValidatorImpl = (input: ValidatorInput) => ValidatorVerdict;

export const VALIDATOR_IMPLEMENTATIONS: Readonly<Record<string, ValidatorImpl>> = {
  // §7.3: every is_required field has a value. Nothing declared → SKIP, not a vacuous PASS.
  'validators#V_ALL_REQUIRED_PRESENT': ({ declared, present }) => {
    if (declared.length === 0) return { status: 'SKIP', detailCode: 'NO_DECLARED_FIELDS' };
    const missing = declared.filter((f) => f.isRequired && !present.has(f.fieldCode));
    return missing.length > 0 ? { status: 'FAIL' } : { status: 'PASS' };
  },
  // §7.5: identical content already on another subject — routes to SECOND_REVIEW (held by the collision rule); recorded as a WARN.
  'validators#V_SHA_COLLISION': ({ collided }) => (collided ? { status: 'WARN', detailCode: 'CROSS_SUBJECT_SHA' } : { status: 'PASS' }),
};

export function resolvesImpl(implRef: string | null | undefined): boolean {
  return typeof implRef === 'string' && Object.hasOwn(VALIDATOR_IMPLEMENTATIONS, implRef);
}
