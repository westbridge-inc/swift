/**
 * [NO-AI · owner rule 2026-09-07] THE PERMANENT NEGATIVE GATE.
 *
 * Identity and document verification is HUMAN review only, in every environment, and
 * nothing model-backed may come back. This file is service-free (vitest.no-ai-kyc.config.ts)
 * and source-level, so it runs anywhere and grades the tree, not a mock. Every assertion
 * was red on the code it removed (the lane report records the mutation runs). It fails
 * the build if:
 *   - an identity adapter other than the manual one exists, the factory or boot accepts
 *     any KYC_PROVIDER but manual, or the dead face-match switches are honoured anywhere
 *     but the boot refusal;
 *   - the adapter contract grows a verdict field, or a submission path writes anything
 *     but PENDING;
 *   - the transition table grows a pair INTO APPROVED or REJECTED that does not start at a
 *     claimed case, or the latest doc-state migration stops mirroring the generator;
 *   - the shift selfie check, its sweep or its job return, in the API or the mobile app;
 *   - a register entry receives a PERSONAL_DOC_IMAGE or BIOMETRIC payload;
 *   - any removed name (provider hosts, adapters, env keys, audit actions, transition
 *     events, gates, hooks) reappears in apps/api/src — tests included.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeBootConfig } from '../utils/boot-config';
import { getKycProvider, ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { DOC_TRANSITIONS, docStateMachineDdl } from '../modules/verification/doc-state';
import { NON_PROCESSOR_DIRS, PROCESSOR_REGISTER } from '../modules/legal/processor-register';
import { JOB_RECOVERY } from '../jobs/recovery-policy';

const API_SRC = join(__dirname, '..');
const API_ROOT = join(API_SRC, '..');
const REPO = join(API_ROOT, '..', '..');
const MOBILE_SRC = join(REPO, 'apps', 'mobile', 'src');
const SELF = 'src/__tests__/no-ai-kyc-gate.unit.test.ts';
/** The legal-text ratchets (owned by the legal step) name the removed identifiers as the historical
 *  evidence they grade; they cannot reintroduce code, so the removed-name scan skips them. */
const LEGAL_RATCHETS = new Set(['src/__tests__/legal-human-review-claim.test.ts', 'src/__tests__/legal-version-binding.test.ts']);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
};
const read = (path: string) => readFileSync(path, 'utf8');
const api = (rel: string) => read(join(API_SRC, rel));
const mobile = (rel: string) => read(join(MOBILE_SRC, rel));
const rel = (file: string) => relative(API_ROOT, file).split('\\').join('/');

// Built from fragments so this file never carries the literals it forbids: a
// repository-wide scan for a removed provider must not find it here.
const P1 = ['di', 'dit'].join('');
const P2 = ['id', 'analyzer'].join('');
const P1_UP = P1.toUpperCase();
const P2_UP = ['ID', 'ANALYZER'].join('_');
const P1_CLASS = `${P1[0]!.toUpperCase()}${P1.slice(1)}KycProvider`;
const P2_CLASS = 'Id' + 'Analyzer' + 'KycProvider';
const P2_FILE = ['id', 'analyzer', 'provider'].join('-');

/** Names that may not appear anywhere in apps/api/src, tests included. */
const FORBIDDEN: Array<{ what: string; re: RegExp }> = [
  { what: 'a removed identity provider host', re: new RegExp(`(?:verification\\.)?${P1}\\.me|(?:api2\\.)?${P2}\\.com`, 'i') },
  { what: 'a removed identity adapter class', re: new RegExp(`${P1_CLASS}|${P2_CLASS}|SandboxKycProvider`) },
  { what: 'a removed identity adapter module', re: new RegExp(`providers/kyc/(?:${P1}-provider|${P2_FILE})`) },
  { what: 'a removed identity provider env key', re: new RegExp(`${P1_UP}_API_(?:KEY|URL)|${P2_UP}_API_(?:KEY|URL)|PROCESSOR_CONTRACT_(?:${P1_UP}|${P2_UP})`) },
  { what: 'an automatic verification decision', re: /kyc:auto|KYC_AUTO_APPROVE|KYC_AUTO_REJECT/ },
  { what: 'a removed automatic transition event', re: /'auto_reject'|'preprocess_fail'|X-AUTO-REJECT/ },
  { what: 'the deleted auto-approval gate', re: /gateAutoApproval|autoApproveEligible|IneligibleReason/ },
  { what: 'a face comparison', re: /biometricFaceMatchEnabled|biometric-guard|verifyIdentity|resolveSignupSelfie|IDENTITY_FACE_MATCH_DOCS/ },
  { what: 'the deleted automatic identity-number capture', re: /captureDocumentNumber|approvedIdentityDocumentNumber|identity-signal-policy|AI_ID_ANALYZER/ },
  { what: 'the removed shift selfie check', re: /midshiftSweep|(?<![\w-])liveness-midshift|LIVENESS_CHECK_REQUIRED|livenessAvailable|LIVENESS_(?:ANALYZER_OUTAGE_POLICY|MIDSHIFT|SHIFT_HOURS|MAX_FAILS)/ },
  { what: 'the removed adapter verdict tri-state', re: /KycStatus|pending_manual/ },
];
/** A line that asserts ABSENCE may name what is absent (a test proving a module or method is gone). */
const NEGATIVE_ASSERTION = /toBeUndefined\(\)|existsSync\(/;
/** The two dead switches may be named only where boot refuses them (and in that test). */
const DEAD_SWITCHES = /FEATURE_BIOMETRIC_FACE_MATCH|LIVENESS_REQUIRED/;
const DEAD_SWITCH_ALLOWLIST = new Set(['src/utils/boot-config.ts', 'src/__tests__/boot-config.test.ts']);

afterEach(() => vi.unstubAllEnvs());

describe('[NO-AI] identity verification is human review only — the permanent gate', () => {
  const files = walk(API_SRC);

  it('the scan finds the trees it grades — a gate that grades nothing is not a gate', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith(join('modules', 'verification', 'verification.service.ts')))).toBe(true);
    expect(existsSync(join(MOBILE_SRC, 'services', 'api.ts'))).toBe(true);
  });

  it('the only identity adapter is the manual one, and only manual can be configured', () => {
    expect(readdirSync(join(API_SRC, 'providers', 'kyc')).sort()).toEqual(['kyc-provider.ts']);
    const contract = api('providers/kyc/kyc-provider.ts');
    expect([...contract.matchAll(/class (\w+) implements KycProvider/g)].map((m) => m[1])).toEqual(['ManualReviewKycProvider']);
    const engine = new ManualReviewKycProvider().engine;
    expect(engine).toEqual({ name: 'manual-review', version: '1', external: false });
    vi.stubEnv('KYC_PROVIDER', 'manual');
    expect(getKycProvider()).toBeInstanceOf(ManualReviewKycProvider);
    for (const name of ['sandbox', P1, P2, 'unknown', '', 'MANUAL']) {
      vi.stubEnv('KYC_PROVIDER', name);
      expect(() => getKycProvider(), name).toThrow(/KYC_PROVIDER must be 'manual'/);
    }
  });

  it('boot refuses any KYC_PROVIDER but manual in every environment, and refuses the dead face-match switches', () => {
    for (const mode of ['test', 'development', 'loadtest', 'production']) {
      for (const provider of [undefined, 'sandbox', P1, P2, 'unknown']) {
        expect(() => assertSafeBootConfig({ NODE_ENV: mode, KYC_PROVIDER: provider }), `${mode}/${provider}`).toThrow(/KYC_PROVIDER must be 'manual'/);
      }
      for (const removed of ['FEATURE_BIOMETRIC_FACE_MATCH', 'LIVENESS_REQUIRED']) {
        expect(() => assertSafeBootConfig({ NODE_ENV: mode, KYC_PROVIDER: 'manual', [removed]: '1' }), `${mode}/${removed}`).toThrow(/has no implementation/);
      }
      if (mode !== 'production') {
        expect(() => assertSafeBootConfig({ NODE_ENV: mode, KYC_PROVIDER: 'manual' }), mode).not.toThrow();
      }
    }
  });

  it('the adapter contract cannot express a decision, and both submission paths write only PENDING', () => {
    const contract = api('providers/kyc/kyc-provider.ts');
    expect(contract).not.toMatch(/\bstatus\??:/);
    expect(contract).not.toMatch(/getStatus/);
    const service = api('modules/verification/verification.service.ts');
    const submitPaths = service.slice(service.indexOf('async submitDocument('), service.indexOf('async reconcileVendorActivations('));
    expect(submitPaths.length).toBeGreaterThan(1000);
    const creates = [...submitPaths.matchAll(/createDocumentLively\(\{[\s\S]*?\}, \{ queue/g)].map((m) => m[0]);
    expect(creates).toHaveLength(2);
    for (const create of creates) {
      expect(create).toMatch(/status: 'PENDING'/);
      expect(create).not.toMatch(/reviewedBy|reviewedAt|expiresAt|reviewNote/);
    }
    expect(submitPaths).not.toMatch(/reviewedBy|reviewedAt/);
    // the identity flow takes a document and nothing else: no selfie parameter, no selfie field in the route schema
    expect(submitPaths).not.toMatch(/selfie/i);
    expect(api('modules/verification/verification.routes.ts')).not.toMatch(/selfieUrl:\s*z\./);
    // no lowercase adapter status is read anywhere in the service, and no verdict is mapped
    expect(service).not.toMatch(/['"](approved|rejected)['"]/);
    expect(service).not.toMatch(/result\.status|received\.status/);
  });

  it('the state machine has no automatic decision: every pair into APPROVED or REJECTED starts at a claimed case', () => {
    const decisions = DOC_TRANSITIONS.filter((t) => t.to === 'APPROVED' || t.to === 'REJECTED');
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((t) => t.from === 'IN_REVIEW'), JSON.stringify(decisions)).toBe(true);
    expect(DOC_TRANSITIONS.some((t) => t.to === 'AUTO_APPROVED')).toBe(false);
    expect(DOC_TRANSITIONS.some((t) => t.from === 'CAPTURED' && t.to === 'REJECTED')).toBe(false);
    expect(DOC_TRANSITIONS.some((t) => t.from === 'VALIDATED' && t.to !== 'REVIEW_QUEUED' && t.to !== 'PURGED')).toBe(false);
  });

  it('the latest doc-state migration mirrors the generator verbatim and carries none of the removed pairs', () => {
    const migrations = join(API_ROOT, 'prisma', 'migrations');
    const humanOnly = read(join(migrations, '20260923170000_no_automatic_kyc_transitions', 'migration.sql'));
    // Graded on the SQL that runs, never on comment lines: a statement commented out is a statement gone.
    const sql = humanOnly.split('\n').filter((l) => !l.startsWith('--')).join('\n');
    for (const statement of docStateMachineDdl()) expect(sql).toContain(statement);
    for (const pair of ["('CAPTURED', 'REJECTED'", "('VALIDATED', 'AUTO_APPROVED'", "('VALIDATED', 'REJECTED'"]) expect(sql).not.toContain(pair);
    // no later migration re-seeds the table behind the generator's back
    const later = readdirSync(migrations).filter((d) => d > '20260923170000_no_automatic_kyc_transitions' && existsSync(join(migrations, d, 'migration.sql')));
    for (const d of later) expect(read(join(migrations, d, 'migration.sql')), d).not.toMatch(/doc_state_transition/);
  });

  it('no processor receives a personal document image or a biometric, and the kyc directory is declared local', () => {
    expect(PROCESSOR_REGISTER.filter((p) => p.payload.includes('PERSONAL_DOC_IMAGE') || p.payload.includes('BIOMETRIC'))).toEqual([]);
    expect(PROCESSOR_REGISTER.filter((p) => p.providerDirs.includes('kyc'))).toEqual([]);
    expect(NON_PROCESSOR_DIRS['kyc']).toMatch(/Manual review/);
  });

  it('the shift selfie check is gone from the API: no check, no sweep, no job, and a route that refuses before reading a body', () => {
    const liveness = api('modules/safety/liveness.service.ts');
    expect(liveness).not.toMatch(/midshift|livenessCheck\.create|LivenessOutcome|selfieUrl|KycProvider/);
    expect(liveness).toMatch(/reportNotMyDriver/); // §7.3 stays
    expect(Object.keys(JOB_RECOVERY).filter((k) => /liveness/i.test(k))).toEqual([]);
    expect(api('jobs/queue.ts')).not.toMatch(/(?<![\w-])liveness-midshift|midshiftSweep|LivenessService/);
    const routes = api('modules/safety/safety.routes.ts');
    const start = routes.indexOf("'/liveness-check'");
    expect(start).toBeGreaterThan(0);
    const handler = routes.slice(start, routes.indexOf('app.post(', start + 1));
    expect(handler).toMatch(/410/);
    expect(handler).not.toMatch(/request\.file\(|getStorageProvider|liveness\.check/);
  });

  it('the shift selfie check is gone from the mobile app, and the identity screen sends no selfie', () => {
    expect(existsSync(join(MOBILE_SRC, 'modules', 'safety', 'screens', 'LivenessCheckScreen.tsx'))).toBe(false);
    expect(mobile('modules/mover/MoverStack.tsx')).not.toMatch(/LivenessCheck/);
    expect(mobile('services/notification-router.ts')).not.toMatch(/liveness_/);
    expect(mobile('hooks/safety.ts')).not.toMatch(/useLivenessCheck|livenessCheck/);
    const client = mobile('services/api.ts');
    expect(client).not.toMatch(/livenessCheck|liveness-check/);
    const submitStart = client.indexOf('submitIdentity:');
    const submitEnd = client.indexOf('/verification/identity', submitStart);
    expect(submitStart).toBeGreaterThan(0);
    expect(submitEnd).toBeGreaterThan(submitStart);
    expect(client.slice(submitStart, submitEnd)).not.toMatch(/selfie/i);
    expect(mobile('modules/account/screens/IdentityVerificationScreen.tsx')).not.toMatch(/selfie/i);
    expect(mobile('components/onboarding/DocumentUploadCard.tsx')).not.toMatch(/Face-matched/);
  });

  it('the env templates and the deploy preflight name manual only', () => {
    for (const template of [join(API_ROOT, '.env.example'), join(REPO, 'deploy', '.env.deploy.example')]) {
      const text = read(template);
      expect(text, template).toMatch(/^KYC_PROVIDER=manual\b/m);
      expect(text, template).not.toMatch(new RegExp(`${P1_UP}|${P2_UP}|sandbox.*identit|identit.*sandbox`, 'i'));
    }
    expect(read(join(REPO, 'deploy', 'preflight.ts'))).toMatch(/KYC_PROVIDER: 'manual'/);
  });

  it('none of the removed names reappears anywhere in apps/api/src (tests included)', () => {
    const hits: string[] = [];
    for (const file of files) {
      const path = rel(file);
      if (path === SELF || LEGAL_RATCHETS.has(path)) continue;
      const lines = read(file).split('\n');
      for (const { what, re } of FORBIDDEN) {
        const line = lines.findIndex((l) => re.test(l) && !NEGATIVE_ASSERTION.test(l));
        if (line >= 0) hits.push(`${path}:${line + 1} — ${what}`);
      }
    }
    expect(hits, 'Verification is human review only. Reintroducing any of these is an owner decision, not a code change.').toEqual([]);
  });

  it('the dead switches are named only where boot refuses them', () => {
    const hits: string[] = [];
    for (const file of files) {
      const path = rel(file);
      if (path === SELF || DEAD_SWITCH_ALLOWLIST.has(path)) continue;
      const line = read(file).split('\n').findIndex((l) => DEAD_SWITCHES.test(l));
      if (line >= 0) hits.push(`${path}:${line + 1}`);
    }
    expect(hits).toEqual([]);
    expect(api('utils/boot-config.ts')).toMatch(/for \(const removed of \['FEATURE_BIOMETRIC_FACE_MATCH', 'LIVENESS_REQUIRED'\]/);
  });
});
