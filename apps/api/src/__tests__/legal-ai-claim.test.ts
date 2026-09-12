import { describe, expect, it } from 'vitest';
import { PRIVACY } from '../modules/legal/legal.routes';
import { PROCESSOR_REGISTER } from '../modules/legal/processor-register';

// ---------------------------------------------------------------------------
// [REPORT-102 / no-AI] THE PRIVACY POLICY MAY NOT OUTRUN THE PROCESSOR REGISTER
//
// The no-AI removal shipped a policy paragraph ending "There is no AI model in
// Swift." That was false at the moment it was written: the identity-verification
// provider posts the ID portrait and selfie to a face-match model, and its
// removal is a SEPARATE change. Nothing caught it, because the only test over
// this text hashes the served bytes — it grades that the words are STABLE, not
// that they are TRUE.
//
// A wrong sentence here is not a typo. This text is served to users, hashed,
// and stamped into the APPEND-ONLY consent ledger: it becomes the words people
// are recorded as having agreed to, and the ledger is kept even after account
// deletion. It cannot be quietly corrected later.
//
// So the claim is graded against the register instead of trusted. When the
// model-backed providers are actually gone, `modelBacked` goes false, and this
// test then REQUIRES the stronger sentence rather than merely permitting it —
// the ratchet turns both ways.
// ---------------------------------------------------------------------------

const modelBacked = PROCESSOR_REGISTER.filter((p) => p.modelBacked);

/** Sentences that claim, without qualification, that no model exists anywhere. */
const BLANKET_DENIALS = [
  /there is no ai model in swift/i,
  /swift (?:uses|contains|has) no ai\b/i,
  /no artificial[- ]intelligence (?:is )?(?:service|processing) (?:is )?used anywhere/i,
];

describe('[no-AI] the Privacy Policy is graded against the processor register', () => {
  it('the register records, per processor, whether a model reads what we send it', () => {
    // If this ever becomes an empty set by accident, every assertion below goes
    // vacuous. Pin that the field is populated on both sides.
    expect(PROCESSOR_REGISTER.length).toBeGreaterThan(5);
    expect(PROCESSOR_REGISTER.every((p) => typeof p.modelBacked === 'boolean')).toBe(true);
    expect(
      PROCESSOR_REGISTER.some((p) => !p.modelBacked),
      'no processor is marked model-free — the field has stopped discriminating',
    ).toBe(true);
  });

  it('while ANY processor is model-backed, the policy makes no blanket no-AI claim', () => {
    if (modelBacked.length === 0) return; // handled by the converse test below
    for (const pattern of BLANKET_DENIALS) {
      expect(
        PRIVACY,
        `the policy claims no model exists, but the register lists ${modelBacked
          .map((p) => p.party)
          .join(', ')} as model-backed — ${pattern}`,
      ).not.toMatch(pattern);
    }
  });

  it('...and it DISCLOSES the model-backed processing it does do', () => {
    if (modelBacked.length === 0) return;
    // The disclosure has to survive rewording, so grade the substance: the
    // policy must say a model runs on the verification document, and must not
    // leave the reader with "nothing is automated".
    expect(PRIVACY).toMatch(/automated[- ](?:document|analysis|reading)/i);
    expect(PRIVACY).toMatch(/face[- ]match/i);
    for (const p of modelBacked) {
      expect(PRIVACY, `${p.party} is model-backed and is not named in the policy`).toContain(p.party);
    }
  });

  it('the narrower true promise survives: nothing the user WRITES goes to a model', () => {
    // This is the sentence the removal deleted and that was accurate. Losing it
    // is how the paragraph ended up making a bigger claim instead of a true one.
    expect(PRIVACY).toMatch(/sends nothing you write to an artificial-intelligence service/i);
  });

  it('once no processor is model-backed, the strong claim becomes REQUIRED, not optional', () => {
    if (modelBacked.length > 0) {
      // Guard the guard: prove this branch is reachable and would bite, rather
      // than silently never running once the providers are removed.
      expect(modelBacked.map((p) => p.ref).sort()).toEqual(['DIDIT', 'ID_ANALYZER']);
      return;
    }
    expect(
      BLANKET_DENIALS.some((pattern) => pattern.test(PRIVACY)),
      'no processor is model-backed any more — the policy should now say so plainly',
    ).toBe(true);
  });
});
