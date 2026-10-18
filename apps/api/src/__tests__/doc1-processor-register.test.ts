/**
 * [DGP-1 · DOC-1 §2 / §10.2(6) · self-test N] The processor register and the fail-closed send gate.
 *
 * Census: every provider directory, every outbound host literal in non-test source, and every
 * external KYC engine must resolve to a register entry or a declared non-processor reason.
 * Gate: a PERSONAL image reaches an external engine only when the doc type allows it, the
 * processor is registered, and its transfer basis (contract reference) is configured.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROCESSOR_REGISTER, NON_PROCESSOR_DIRS, CONTRACT_GATED_PAYLOADS, assertExternalProcessingPermitted,
  coverageOfHost, coverageOfProviderDir, outboundHostLiterals, processorByRef, processorStatus, needsContract,
  processorRegisterView, POLICY_NAMED_WITHOUT_EGRESS,
} from '../modules/legal/processor-register';
import { DiditKycProvider } from '../providers/kyc/didit-provider';
import { IdAnalyzerKycProvider } from '../providers/kyc/id-analyzer-provider';
import { UNKNOWN_ENGINE } from '../modules/verification/extraction-ledger';
import { PRIVACY } from '../modules/legal/legal.routes';

const SRC = join(__dirname, '..');
const EXTERNAL_DIDIT = { name: 'didit', version: 'v3', external: true, processorRef: 'DIDIT' } as const;
const LOCAL = { name: 'sandbox', version: '1', external: false } as const;
const allows = { code: 'national_id', externalProcessingAllowed: true };
const forbids = { code: 'national_id', externalProcessingAllowed: false };
const codeOf = (fn: () => void) => { try { fn(); return null; } catch (e) { return (e as { code?: string; statusCode?: number }); } };

describe('[DGP-1] the register is complete for what the code can reach', () => {
  it('test_every_provider_dir_is_registered_or_declared: src/providers/* each resolve to a processor or a non-processor reason', () => {
    const dirs = readdirSync(join(SRC, 'providers'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs.length).toBeGreaterThan(5);
    const missing = dirs.filter((d) => coverageOfProviderDir(d) === null);
    expect(missing, `provider directories with no register entry and no declared reason: ${missing.join(', ')}`).toEqual([]);
    // and no phantom declarations: every providerDir / non-processor dir must exist on disk
    const declared = new Set([...PROCESSOR_REGISTER.flatMap((p) => p.providerDirs), ...Object.keys(NON_PROCESSOR_DIRS)]);
    expect([...declared].filter((d) => !dirs.includes(d))).toEqual([]);
  });

  it('test_every_outbound_host_literal_is_registered: no undeclared egress host in non-test source', () => {
    const hosts = outboundHostLiterals(SRC);
    expect(hosts.size).toBeGreaterThan(5);
    const undeclared = [...hosts.entries()].filter(([h]) => coverageOfHost(h) === null).map(([h, files]) => `${h} (${files.join(', ')})`);
    expect(undeclared, `outbound hosts with no register entry: ${undeclared.join('; ')}`).toEqual([]);
  });

  it('test_external_kyc_engines_are_registered: every external engine names an entry that carries the PERSONAL image classes', () => {
    // a local .env may carry the keys as EMPTY strings; the adapters need any non-empty value to construct
    for (const k of ['DIDIT_API_KEY', 'ID_ANALYZER_API_KEY']) if (!process.env[k]) process.env[k] = 'test';
    for (const engine of [new DiditKycProvider().engine, new IdAnalyzerKycProvider().engine]) {
      expect(engine.external).toBe(true);
      const entry = processorByRef(engine.processorRef);
      expect(entry, `engine ${engine.name} → ${engine.processorRef}`).not.toBeNull();
      expect(entry!.payload).toContain('PERSONAL_DOC_IMAGE');
      expect(needsContract(entry!)).toBe(true);
      expect(entry!.contractEnv).toMatch(/^PROCESSOR_CONTRACT_/);
    }
    expect(processorByRef(UNKNOWN_ENGINE.processorRef)).toBeNull();
  });

  it('every entry is internally consistent: personal payloads leaving the country carry a contract env, self-hosted never leaves, NOT_APPLICABLE only for non-personal', () => {
    const refs = PROCESSOR_REGISTER.map((p) => p.ref);
    expect(new Set(refs).size).toBe(refs.length);
    for (const p of PROCESSOR_REGISTER) {
      if (needsContract(p)) expect(p.contractEnv, p.ref).toBeTruthy();
      if (p.transferBasis === 'SELF_HOSTED' || p.transferBasis === 'IN_COUNTRY') expect(p.leavesCountry, p.ref).toBe(false);
      if (p.leavesCountry) expect(['CONTRACT_CLAUSES', 'NOT_APPLICABLE'], p.ref).toContain(p.transferBasis);
      if (p.transferBasis === 'NOT_APPLICABLE') expect(p.payload, p.ref).toEqual(['NON_PERSONAL']);
      if (p.payload.some((c) => CONTRACT_GATED_PAYLOADS.has(c))) expect(p.transferBasis, p.ref).not.toBe('NOT_APPLICABLE');
    }
  });

  it('the object store receives ciphertext only: production boot refuses without MASTER_KEK', () => {
    const boot = readFileSync(join(SRC, 'utils/boot-config.ts'), 'utf8');
    expect(boot).toMatch(/MASTER_KEK is required in production/);
    expect(processorByRef('OBJECT_STORE')!.payload).toEqual(['PERSONAL_DOC_CIPHERTEXT']);
  });

  // [#1452 follow-up] The Privacy Policy tells people Swift's servers, databases and encrypted document
  // storage are with DigitalOcean. The register is the internal record of the same fact, so it names the
  // same company for both, and the host holds the database (account fields) as well as the ciphertext.
  it('the hosting and document-storage rows name the company the Privacy Policy names (DigitalOcean)', () => {
    expect(PRIVACY).toMatch(/DigitalOcean \(hosts Swift's servers and databases, and the encrypted storage for verification documents/);
    expect(PRIVACY).toMatch(/Our servers are with DigitalOcean/);
    const hosting = processorByRef('HOSTING');
    expect(hosting, 'HOSTING row').not.toBeNull();
    expect(hosting!.party).toMatch(/^DigitalOcean\b/);
    expect(hosting!.payload).toEqual(expect.arrayContaining(['IDENTITY_FIELDS', 'CONTACT', 'LOCATION', 'PERSONAL_DOC_CIPHERTEXT']));
    expect(hosting!.payload).not.toContain('PERSONAL_DOC_IMAGE');
    expect(hosting!.leavesCountry).toBe(true);
    expect(hosting!.contractEnv).toBe('PROCESSOR_CONTRACT_HOSTING');
    const store = processorByRef('OBJECT_STORE')!;
    expect(store.party).toMatch(/^DigitalOcean Spaces\b/);
    expect(store.hosts).toContain('digitaloceanspaces.com');
  });

  // [COORD 18 Oct, item 3] Every party the Privacy Policy's processor paragraph names resolves to a register
  // row, or to a declared reason why Swift's code sends it nothing. A row named here as used at launch is never
  // marked dormant, and the policy never names a row the register says is not used at launch.
  const processorsParagraph = /<p><b>Technical service providers \(processors\):<\/b>[\s\S]*?<\/p>/.exec(PRIVACY)?.[0] ?? '';
  const POLICY_TO_REGISTER: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['DigitalOcean', 'HOSTING', /^DigitalOcean\b/], ['DigitalOcean', 'OBJECT_STORE', /^DigitalOcean Spaces\b/],
    ['Cloudflare', 'CLOUDFLARE', /^Cloudflare\b/], ['Twilio', 'TWILIO', /^Twilio\b/], ['Expo', 'EXPO_PUSH', /^Expo\b/],
    ['GoDaddy', 'SMTP_EMAIL', /^GoDaddy\b/], ['MMG', 'MMG', /^Mobile Money Guyana\b/],
    ['Google Places', 'GOOGLE_PLACES', /^Google LLC \(Places API/], ['MapTiler', 'MAPTILER', /^MapTiler\b/],
  ];
  it('every processor the Privacy Policy names has a register row or a declared no-egress reason', () => {
    expect(processorsParagraph.length).toBeGreaterThan(200);
    for (const [name, ref, party] of POLICY_TO_REGISTER) {
      expect(processorsParagraph, `the policy names ${name}`).toContain(name);
      const row = processorByRef(ref);
      expect(row, `${name} -> register row ${ref}`).not.toBeNull();
      expect(row!.party, `${ref} party`).toMatch(party);
      expect(row!.note, `${ref} is used at launch`).not.toMatch(/NOT USED|DORMANT/);
    }
    for (const name of Object.keys(POLICY_NAMED_WITHOUT_EGRESS)) {
      expect(processorsParagraph, `declared ${name} is still named`).toContain(name);
    }
    for (const p of PROCESSOR_REGISTER.filter((r) => /NOT USED|DORMANT/.test(r.note))) {
      expect(processorsParagraph, `${p.ref} is not used at launch but the policy names it`).not.toContain(p.party);
    }
    expect(processorsParagraph).not.toMatch(/Distance Matrix/);
  });

  it('Google: address search from Swift\'s servers is the live row; the routing adapter is not used at launch', () => {
    expect(coverageOfProviderDir('places')).toEqual({ kind: 'PROCESSOR', refs: ['GOOGLE_PLACES', 'OSM_PLACES'] });
    expect(coverageOfHost('places.googleapis.com')).toEqual({ kind: 'PROCESSOR', ref: 'GOOGLE_PLACES' });
    expect(processorByRef('GOOGLE_MAPS')!.providerDirs).toEqual(['maps']);
    expect(processorByRef('GOOGLE_MAPS')!.note).toMatch(/^NOT USED AT LAUNCH/);
    expect(PRIVACY).toMatch(/Routes and travel estimates run on Swift's own servers/);
  });

  it('the live verification path calls the gate at both send sites (doc submission and the L1→L2 identity check)', () => {
    const svc = readFileSync(join(SRC, 'modules/verification/verification.service.ts'), 'utf8');
    expect(svc.match(/assertExternalProcessingPermitted\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    for (const call of svc.matchAll(/assertExternalProcessingPermitted\([^\n]*/g)) expect(call[0]).toMatch(/this\.kyc\.engine/);
  });
});

describe('[DGP-1 · DOC-1 §2] the send gate is fail-closed', () => {
  it('test_external_send_refused_when_doc_type_forbids: an external engine never sees a type whose registry row forbids external processing', () => {
    const env = { PROCESSOR_CONTRACT_DIDIT: 'DPA-2026-001' };
    expect(codeOf(() => assertExternalProcessingPermitted(forbids, EXTERNAL_DIDIT, env))).toMatchObject({ statusCode: 503, code: 'PROCESSOR_NOT_PERMITTED' });
    // unknown to the registry = forbidden (fail closed), never "allowed by absence"
    expect(codeOf(() => assertExternalProcessingPermitted({ code: 'mystery', externalProcessingAllowed: null }, EXTERNAL_DIDIT, env))).toMatchObject({ code: 'PROCESSOR_NOT_PERMITTED' });
  });

  it('test_external_send_refused_without_registered_processor: an engine with no register entry is refused even when the type allows', () => {
    const env = { PROCESSOR_CONTRACT_DIDIT: 'DPA-2026-001' };
    expect(codeOf(() => assertExternalProcessingPermitted(allows, { ...EXTERNAL_DIDIT, processorRef: 'ACME_OCR' }, env))).toMatchObject({ statusCode: 503, code: 'PROCESSOR_UNREGISTERED' });
    expect(codeOf(() => assertExternalProcessingPermitted(allows, UNKNOWN_ENGINE, env))).toMatchObject({ code: 'PROCESSOR_UNREGISTERED' });
  });

  it('test_external_send_refused_without_transfer_basis: a registered processor with no configured contract reference is DORMANT and refused; with one it passes', () => {
    expect(processorStatus(processorByRef('DIDIT')!, {})).toBe('DORMANT_NO_CONTRACT');
    expect(codeOf(() => assertExternalProcessingPermitted(allows, EXTERNAL_DIDIT, {}))).toMatchObject({ statusCode: 503, code: 'PROCESSOR_NO_TRANSFER_BASIS' });
    expect(codeOf(() => assertExternalProcessingPermitted(allows, EXTERNAL_DIDIT, { PROCESSOR_CONTRACT_DIDIT: '   ' }))).toMatchObject({ code: 'PROCESSOR_NO_TRANSFER_BASIS' });
    expect(processorStatus(processorByRef('DIDIT')!, { PROCESSOR_CONTRACT_DIDIT: 'DPA-2026-001' })).toBe('ACTIVE');
    expect(codeOf(() => assertExternalProcessingPermitted(allows, EXTERNAL_DIDIT, { PROCESSOR_CONTRACT_DIDIT: 'DPA-2026-001' }))).toBeNull();
  });

  it('test_local_engine_never_gated: an in-process engine passes regardless of the registry row or env', () => {
    expect(codeOf(() => assertExternalProcessingPermitted(forbids, LOCAL, {}))).toBeNull();
    expect(codeOf(() => assertExternalProcessingPermitted({ code: 'x', externalProcessingAllowed: null }, undefined, {}))).toBeNull();
  });

  it('the admin view resolves status from env and never exposes the reference value', () => {
    const view = processorRegisterView({ PROCESSOR_CONTRACT_DIDIT: 'DPA-2026-001' });
    const didit = view.find((p) => p.ref === 'DIDIT')!;
    expect(didit.status).toBe('ACTIVE'); expect(didit.contractConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('DPA-2026-001');
    expect(view.find((p) => p.ref === 'ID_ANALYZER')!.status).toBe('DORMANT_NO_CONTRACT');
    expect(view.find((p) => p.ref === 'MMG')!.status).toBe('ACTIVE');
  });
});
