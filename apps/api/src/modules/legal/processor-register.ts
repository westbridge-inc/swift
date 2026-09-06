/**
 * [DGP-1 · DOC-1 §10.2(6) · self-test N] THE PROCESSOR REGISTER.
 *
 * Every third party that can receive a byte of anything Swift holds about a person, declared
 * in code with the payload class it receives, the lawful basis, where it sits, whether data
 * leaves Guyana, and the transfer basis. DOC-1 §2 (hard limits) rules that a PERSONAL-bucket
 * image may be sent to an external processor only when the doc type allows it AND the
 * processor is in this register AND a transfer basis exists; `assertExternalProcessingPermitted`
 * is that rule at the send site, fail-closed.
 *
 * Contract references are env-configured (`contractEnv`) so the register never carries a
 * document number in a public repo: an entry that needs a contract is ACTIVE only while its
 * reference is configured. The founder records the signed DPA's reference; nothing here is a
 * secret.
 *
 * The CI census (`doc1-processor-register.test.ts`) keeps this list honest: every provider
 * directory, every outbound host literal and every external KYC engine must resolve to an
 * entry or to a declared non-processor reason. A new egress with no row fails CI.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AppError } from '../../utils/errors';
import type { KycEngine } from '../../providers/kyc/kyc-provider';

type Env = Record<string, string | undefined>;

export type PayloadClass =
  | 'PERSONAL_DOC_IMAGE' | 'PERSONAL_DOC_CIPHERTEXT' | 'BIOMETRIC' | 'IDENTITY_FIELDS'
  | 'CONTACT' | 'LOCATION' | 'PAYMENT' | 'DEVICE_TOKEN' | 'DIAGNOSTIC' | 'NON_PERSONAL';
export type TransferBasis = 'IN_COUNTRY' | 'SELF_HOSTED' | 'CONTRACT_CLAUSES' | 'NOT_APPLICABLE';
export type LawfulBasis = 'CONTRACT' | 'LEGAL_OBLIGATION' | 'LEGITIMATE_INTEREST' | 'CONSENT';
export type ProcessorStatus = 'ACTIVE' | 'DORMANT_NO_CONTRACT';

export interface ProcessorEntry {
  ref: string;
  party: string;
  service: string;
  /** `src/providers/<dir>` directories this party backs (census key). */
  providerDirs: readonly string[];
  /** Host suffixes the party is reached at (defaults and env-configured endpoints). */
  hosts: readonly string[];
  payload: readonly PayloadClass[];
  lawfulBasis: LawfulBasis;
  /** Where the processing happens, as recorded for the transfer register. */
  country: string;
  leavesCountry: boolean;
  transferBasis: TransferBasis;
  /** Env var holding the signed contract / DPA reference; null when the payload never needs one. */
  contractEnv: string | null;
  note: string;
}

/** Payload classes whose external processing needs a recorded contract before a byte moves. */
export const CONTRACT_GATED_PAYLOADS: ReadonlySet<PayloadClass> = new Set([
  'PERSONAL_DOC_IMAGE', 'PERSONAL_DOC_CIPHERTEXT', 'BIOMETRIC', 'IDENTITY_FIELDS',
]);

export const PROCESSOR_REGISTER: readonly ProcessorEntry[] = [
  {
    ref: 'DIDIT', party: 'Didit', service: 'Identity verification: ID document image, selfie, liveness, OCR',
    providerDirs: ['kyc'], hosts: ['verification.didit.me', 'didit.me'],
    payload: ['PERSONAL_DOC_IMAGE', 'BIOMETRIC', 'IDENTITY_FIELDS'], lawfulBasis: 'LEGAL_OBLIGATION',
    country: 'vendor-hosted (EU/US)', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES',
    contractEnv: 'PROCESSOR_CONTRACT_DIDIT',
    note: 'KYC_PROVIDER=didit. Biometric operations additionally need FD-D5 (FEATURE_BIOMETRIC_FACE_MATCH).',
  },
  {
    ref: 'ID_ANALYZER', party: 'ID Analyzer', service: 'Document OCR + biometric match',
    providerDirs: ['kyc'], hosts: ['api2.idanalyzer.com', 'idanalyzer.com'],
    payload: ['PERSONAL_DOC_IMAGE', 'BIOMETRIC', 'IDENTITY_FIELDS'], lawfulBasis: 'LEGAL_OBLIGATION',
    country: 'vendor-hosted (US)', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES',
    contractEnv: 'PROCESSOR_CONTRACT_ID_ANALYZER',
    note: 'KYC_PROVIDER=id-analyzer. Same gate as Didit.',
  },
  {
    ref: 'OBJECT_STORE', party: 'Cloudflare R2 / AWS S3 (S3-compatible endpoint)', service: 'Object storage for uploaded documents',
    providerDirs: ['storage'], hosts: ['r2.cloudflarestorage.com', 'amazonaws.com'],
    payload: ['PERSONAL_DOC_CIPHERTEXT'], lawfulBasis: 'CONTRACT',
    country: 'vendor region (AWS_S3_ENDPOINT)', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES',
    contractEnv: 'PROCESSOR_CONTRACT_OBJECT_STORE',
    note: 'Receives ciphertext only: boot-config refuses production without MASTER_KEK (envelope encryption).',
  },
  {
    ref: 'SENTRY', party: 'Functional Software, Inc. (Sentry)', service: 'Error and performance telemetry',
    providerDirs: [], hosts: ['sentry.io'],
    payload: ['DIAGNOSTIC'], lawfulBasis: 'LEGITIMATE_INTEREST',
    country: 'US', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES', contractEnv: null,
    note: 'Events are scrubbed by the observability plugin; a document byte in an event is a bug, not a flow.',
  },
  {
    ref: 'TWILIO', party: 'Twilio Inc.', service: 'SMS one-time codes and notices',
    providerDirs: ['notifications'], hosts: ['api.twilio.com', 'twilio.com'],
    payload: ['CONTACT'], lawfulBasis: 'CONTRACT',
    country: 'US', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES', contractEnv: null,
    note: 'Phone number + message body. OTP values are never logged (pino redaction).',
  },
  {
    ref: 'EXPO_PUSH', party: 'Expo (650 Industries)', service: 'Push notification relay',
    providerDirs: ['notifications'], hosts: ['exp.host', 'expo.dev'],
    payload: ['DEVICE_TOKEN', 'CONTACT'], lawfulBasis: 'CONTRACT',
    country: 'US', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES', contractEnv: null,
    note: 'Push token + notification title/body (order references, first names).',
  },
  {
    ref: 'SMTP_EMAIL', party: 'GoDaddy mailbox (SMTP)', service: 'Transactional email',
    providerDirs: ['notifications'], hosts: ['secureserver.net', 'godaddy.com', 'titan.email'],
    payload: ['CONTACT'], lawfulBasis: 'CONTRACT',
    country: 'US', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES', contractEnv: null,
    note: 'SMTP_HOST-configured; email address + message body.',
  },
  {
    ref: 'GOOGLE_MAPS', party: 'Google LLC (Maps Platform)', service: 'Places autocomplete, geocoding, distance matrix',
    providerDirs: ['maps', 'places'], hosts: ['maps.googleapis.com', 'googleapis.com'],
    payload: ['LOCATION'], lawfulBasis: 'CONTRACT',
    country: 'US', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES', contractEnv: null,
    note: 'DORMANT BY FOUNDER DECISION (2026-09-07: maps self-hosted, all engines). Adapter kept behind MAPS_PROVIDER=google / PLACES_PROVIDER=google; no key is provisioned. Coordinates and typed addresses, no identity.',
  },
  {
    ref: 'OSRM', party: 'Swift (self-hosted OSRM)', service: 'Routing and ETAs',
    providerDirs: ['maps'], hosts: [], payload: ['LOCATION'], lawfulBasis: 'CONTRACT',
    country: 'Swift infrastructure', leavesCountry: false, transferBasis: 'SELF_HOSTED', contractEnv: null,
    note: 'OSRM_URL; no third party.',
  },
  {
    ref: 'VROOM', party: 'Swift (self-hosted VROOM)', service: 'Dispatch and batch planning',
    providerDirs: ['dispatch'], hosts: [], payload: ['LOCATION'], lawfulBasis: 'CONTRACT',
    country: 'Swift infrastructure', leavesCountry: false, transferBasis: 'SELF_HOSTED', contractEnv: null,
    note: 'VROOM_URL; no third party.',
  },
  {
    ref: 'OSM_PLACES', party: 'Swift (self-hosted Photon + Nominatim)', service: 'Address search and reverse geocoding',
    providerDirs: ['places'], hosts: [], payload: ['LOCATION'], lawfulBasis: 'CONTRACT',
    country: 'Swift infrastructure', leavesCountry: false, transferBasis: 'SELF_HOSTED', contractEnv: null,
    note: 'PHOTON_URL / NOMINATIM_URL; no public OSM endpoint is a default.',
  },
  {
    ref: 'MMG', party: 'Mobile Money Guyana (GTT)', service: 'Merchant subscription payments',
    providerDirs: ['mmg'], hosts: ['mmg.gy', 'mmgtest.net'],
    payload: ['PAYMENT', 'CONTACT'], lawfulBasis: 'CONTRACT',
    country: 'GY', leavesCountry: false, transferBasis: 'IN_COUNTRY', contractEnv: null,
    note: 'Merchant agreement. Phone number + amount + reference; no documents.',
  },
  {
    ref: 'POWERTRANZ', party: 'PowerTranz (First Atlantic Commerce)', service: 'Card payment gateway',
    providerDirs: ['payment'], hosts: ['ptranz.com'],
    payload: ['PAYMENT'], lawfulBasis: 'CONTRACT',
    country: 'Barbados (Caribbean)', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES', contractEnv: null,
    note: 'Card data is tokenised at the gateway; Swift never stores PANs.',
  },
  {
    ref: 'STRIPE', party: 'Stripe, Inc.', service: 'Card payment gateway (dormant — V1 is cash-only)',
    providerDirs: ['payment'], hosts: ['api.stripe.com', 'stripe.com'],
    payload: ['PAYMENT'], lawfulBasis: 'CONTRACT',
    country: 'US', leavesCountry: true, transferBasis: 'CONTRACT_CLAUSES', contractEnv: null,
    note: 'Adapter exists; not selected by any production configuration.',
  },
  {
    ref: 'ANTHROPIC', party: 'Anthropic, PBC', service: 'LLM classification and assist (ops agent, search assist)',
    providerDirs: [], hosts: ['api.anthropic.com'],
    payload: ['NON_PERSONAL'], lawfulBasis: 'LEGITIMATE_INTEREST',
    country: 'US', leavesCountry: true, transferBasis: 'NOT_APPLICABLE', contractEnv: null,
    note: 'PII-free by construction (ai.service.ts, agent.service.ts): enums, ids, counts, scrubbed text. Money/auth/verification never call it.',
  },
];

/** Provider directories that are not a processor, with the reason the census accepts. */
export const NON_PROCESSOR_DIRS: Readonly<Record<string, string>> = {
  prescreen: 'in-process heuristics (HeuristicAdPreScreenProvider); no network call',
};

/** Outbound host literals in source that are not processors, with the reason. */
export const NON_PROCESSOR_HOSTS: Readonly<Record<string, string>> = {
  'swift.gy': 'own domain', 'app.swift.gy': 'own domain', 'api.swift.gy': 'own domain',
  'officialgazette.gov.gy': 'public read (commencement watch fetches public notices; sends nothing)',
  'www.parliament.gov.gy': 'public read (commencement watch)',
  'play.google.com': 'link rendered to users; no server call',
  'wa.me': 'link rendered to users; no server call',
  'maps.google.com': 'map link inside SOS messages to emergency contacts; no server call',
};

export function processorByRef(ref: string | undefined | null): ProcessorEntry | null {
  if (!ref) return null;
  return PROCESSOR_REGISTER.find((p) => p.ref === ref) ?? null;
}

export function needsContract(entry: ProcessorEntry): boolean {
  return entry.leavesCountry && entry.payload.some((p) => CONTRACT_GATED_PAYLOADS.has(p));
}

/** ACTIVE, or DORMANT_NO_CONTRACT when the payload needs a recorded contract and none is configured. */
export function processorStatus(entry: ProcessorEntry, env: Env = process.env): ProcessorStatus {
  if (!needsContract(entry)) return 'ACTIVE';
  const ref = entry.contractEnv ? env[entry.contractEnv] : undefined;
  return ref && ref.trim().length > 0 ? 'ACTIVE' : 'DORMANT_NO_CONTRACT';
}

export interface ExternalProcessingSubject {
  code: string;
  /** From the doc registry row; a type the registry does not know is treated as forbidden. */
  externalProcessingAllowed: boolean | null | undefined;
}

/**
 * DOC-1 §2: a PERSONAL image goes to an external processor only if the doc type allows it,
 * the processor is registered, and a transfer basis exists. Local engines are never gated.
 * 503 because the failure is the server's configuration, never the person's document.
 */
export function assertExternalProcessingPermitted(
  subject: ExternalProcessingSubject,
  engine: KycEngine | undefined,
  env: Env = process.env,
): void {
  if (!engine || !engine.external) return;
  if (subject.externalProcessingAllowed !== true) {
    throw new AppError(503, 'PROCESSOR_NOT_PERMITTED', 'This document cannot be checked externally right now. Please try again later.');
  }
  const entry = processorByRef(engine.processorRef);
  if (!entry) {
    throw new AppError(503, 'PROCESSOR_UNREGISTERED', 'This document cannot be checked externally right now. Please try again later.');
  }
  if (processorStatus(entry, env) !== 'ACTIVE') {
    throw new AppError(503, 'PROCESSOR_NO_TRANSFER_BASIS', 'This document cannot be checked externally right now. Please try again later.');
  }
}

/** The register as the admin surface reads it: status resolved, nothing secret. */
export function processorRegisterView(env: Env = process.env) {
  return PROCESSOR_REGISTER.map((p) => ({ ...p, status: processorStatus(p, env), contractConfigured: p.contractEnv ? Boolean(env[p.contractEnv]) : null }));
}

// ---- census helpers (pure; used by the CI test) ----------------------------------------

const HOST_LITERAL = /https?:\/\/([a-zA-Z0-9.-]+)/g;

/** Every host literal in non-test TypeScript under `root`, with the file it lives in. */
export function outboundHostLiterals(root: string): Map<string, string[]> {
  const hosts = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { if (entry !== '__tests__' && entry !== 'node_modules') walk(full); continue; }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const code = readFileSync(full, 'utf8');
      for (const m of code.matchAll(HOST_LITERAL)) {
        const host = m[1]!.toLowerCase();
        // not egress: bare names, .test/.localhost fixtures, IP literals (CORS origins), localhost
        if (!host.includes('.') || host.endsWith('.test') || host.endsWith('.localhost') || host === 'localhost' || /^\d+(\.\d+){3}$/.test(host)) continue;
        const list = hosts.get(host) ?? [];
        list.push(relative(root, full));
        hosts.set(host, list);
      }
    }
  };
  walk(root);
  return hosts;
}

/** The register entry (or non-processor reason) a host resolves to; null = undeclared egress. */
export function coverageOfHost(host: string): { kind: 'PROCESSOR'; ref: string } | { kind: 'NON_PROCESSOR'; reason: string } | null {
  const h = host.toLowerCase();
  const own = NON_PROCESSOR_HOSTS[h];
  if (own) return { kind: 'NON_PROCESSOR', reason: own };
  for (const p of PROCESSOR_REGISTER) {
    if (p.hosts.some((s) => h === s || h.endsWith('.' + s))) return { kind: 'PROCESSOR', ref: p.ref };
  }
  return null;
}

export function coverageOfProviderDir(dir: string): { kind: 'PROCESSOR'; refs: string[] } | { kind: 'NON_PROCESSOR'; reason: string } | null {
  const refs = PROCESSOR_REGISTER.filter((p) => p.providerDirs.includes(dir)).map((p) => p.ref);
  if (refs.length) return { kind: 'PROCESSOR', refs };
  const reason = NON_PROCESSOR_DIRS[dir];
  return reason ? { kind: 'NON_PROCESSOR', reason } : null;
}
