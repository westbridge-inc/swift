import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIVACY } from '../modules/legal/legal.routes';
import { DOC_TRANSITIONS } from '../modules/verification/doc-state';

// ---------------------------------------------------------------------------
// [F-1218-02] THE PRIVACY POLICY MAY NOT PROMISE A PERSON THE CODE DOES NOT PROVIDE
//
// #1218's first privacy paragraph said the identity check's automated results
// "produce a flag for a person to review, never a decision on their own". The
// document state machine says otherwise: VALIDATED → REJECTED on `auto_reject`
// is a licensed transition (X-AUTO-REJECT, CONFLICT-DOC-8), CAPTURED → REJECTED
// on `preprocess_fail` is another, and the verification service records a
// provider's decline as REJECTED under `reviewedBy: 'kyc:auto'` with a
// KYC_AUTO_REJECT audit row — no person in the loop. The sentence was a promise,
// hashed into the append-only consent ledger, that the code did not keep.
// Independent review of #1218 (F-1218-02) caught it.
//
// So the claim is graded against the machine, the way legal-ai-claim.test.ts
// grades the no-AI claim against the processor register:
//   - while a machine can reject a document on its own, the policy may not say
//     the check only flags, and must say that it can reject;
//   - once no such transition exists, the disclosure becomes the stale claim,
//     and the same test turns the other way.
// ---------------------------------------------------------------------------

const service = readFileSync(join(__dirname, '../modules/verification/verification.service.ts'), 'utf8');

/** Transitions into REJECTED that no reviewer takes: the machine's own rejections. */
const machineRejections = DOC_TRANSITIONS.filter((t) => t.to === 'REJECTED' && t.from !== 'IN_REVIEW');
/** The service wires a provider's decline straight to REJECTED under the automatic reviewer. */
const serviceAutoRejects =
  /result\.status === 'rejected' \? 'REJECTED'/.test(service) && service.includes("'KYC_AUTO_REJECT'");
const automaticRejection = machineRejections.length > 0 || serviceAutoRejects;

/** The "AI processing" paragraph: the one place the policy describes what the identity check's automation does. */
const aiParagraph = /<p><b>AI processing:<\/b>[\s\S]*?<\/p>/.exec(PRIVACY)?.[0] ?? '';

/** Ways of saying a person decides and the machine never does. */
const HUMAN_ONLY_CLAIMS = [
  /never a decision on (?:its|their) own/i,
  /produces? (?:only )?a flag for a person/i,
  /only (?:ever )?flags?\b/i,
  /(?:always|only) reviewed by a (?:person|human)/i,
  /no (?:automated|automatic) (?:decision|rejection)/i,
  /section 4 applies to them in full/i,
];

describe('[F-1218-02] the Privacy Policy is graded against the document state machine', () => {
  it('the machine and the service agree on whether a document can be rejected without a person', () => {
    // Guard the guard: the two evidence sources must not drift apart, or the
    // ratchet below would turn on half a fact.
    expect(machineRejections.length > 0).toBe(serviceAutoRejects);
  });

  it('the identity check is described in exactly one paragraph, so the words graded are the words served', () => {
    // [NO-AI · #1276] This paragraph was anchored on the provider it named. No provider exists
    // now, so it is anchored on what it describes; and no other paragraph may describe the check,
    // or name a removed provider, where this ratchet would not grade the words.
    expect(aiParagraph).toMatch(/identity documents?/i);
    expect(aiParagraph).toMatch(/face[- ]match/i);
    expect(PRIVACY.split('<p><b>AI processing:</b>')).toHaveLength(2);
    expect(PRIVACY.replace(aiParagraph, '')).not.toMatch(/face[- ]match/i);
    expect(PRIVACY).not.toMatch(/Didit|ID Analyzer/);
  });

  it('while a machine can reject a document on its own, the policy does not promise a person', () => {
    if (!automaticRejection) return; // the converse test below
    const evidence = machineRejections.map((t) => `${t.from} → ${t.to} on ${t.event} (${t.spec})`).join('; ');
    for (const pattern of HUMAN_ONLY_CLAIMS) {
      expect(
        aiParagraph,
        `the policy promises human-only review, but the machine rejects without one — ${evidence} — ${pattern}`,
      ).not.toMatch(pattern);
    }
  });

  it('...and it SAYS the check can reject, because that is what it does', () => {
    if (!automaticRejection) return;
    // The disclosure has to survive rewording, so grade the substance: the
    // result can accept or reject, and a rejection can be submitted again —
    // which is what notifyRejection tells the person, and no more than that.
    expect(aiParagraph).toMatch(/can (?:accept|approve)[^.]*\breject\b/i);
    expect(aiParagraph).toMatch(/submit (?:it )?again|resubmit/i);
  });

  it('once no machine rejection exists, the disclosure of one becomes the false claim', () => {
    if (automaticRejection) {
      // Prove this branch is reachable and would bite: name the exact
      // transitions that keep it dormant.
      expect(machineRejections.map((t) => t.event).sort()).toEqual(['auto_reject', 'preprocess_fail']);
      return;
    }
    expect(aiParagraph, 'no machine rejection exists any more — the policy still says the check can reject').not.toMatch(/\breject/i);
  });
});
