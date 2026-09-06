/**
 * [DOC-1 Part XXI · DOC-INV-28 · P21] The degradation ladder.
 *
 * The governing rule: fail CLOSED on anything that would grant access, fail OPEN on
 * anything that merely delays it. An extraction outage may delay onboarding; it may
 * never approve.
 *  - Extraction service down / hung: the submission is ACCEPTED and queued for a human
 *    (T6), the actor sees "received, under review", the run records the outage.
 *  - Model returns garbage: a circuit breaker per document type — schema-violation rate
 *    above 10% over the last 100 runs disables the model leg for that type (manual
 *    keying), and alarms once.
 *  - Key service unreachable (production): no new intake, no approvals — never plaintext
 *    "temporarily". Existing verified actors keep operating on the materialised
 *    eligibility flags (§21.3), which are recomputed on document state change.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import type { KycProvider, KycVerificationResult } from '../../providers/kyc/kyc-provider';
import { getKeyProvider } from '../../providers/storage/envelope';
import { isProduction } from '../../utils/runtime-mode';
import { AppError } from '../../utils/errors';

export const EXTRACTION_UNAVAILABLE = 'EXTRACTION_UNAVAILABLE';
export const L3_DISABLED = 'L3_DISABLED';
export const BREAKER_WINDOW = 100;
export const BREAKER_THRESHOLD = 0.10;

export const extractionTimeoutMs = (): number => {
  const v = Number(process.env['EXTRACTION_TIMEOUT_MS']);
  return Number.isFinite(v) && v > 0 ? v : 20_000;
};

export type DegradedResult = KycVerificationResult & { degraded?: string };

/**
 * Call the extraction adapter with a hard bound. A throw or a hang is an OUTAGE, not a
 * verdict: the result is `pending_manual` tagged with the outage, so the submission
 * queues for a human and can never reach an approval.
 */
export function extractWithLadder(
  call: () => Promise<KycVerificationResult>,
  opts: { timeoutMs?: number } = {},
): Promise<DegradedResult> {
  const timeoutMs = opts.timeoutMs ?? extractionTimeoutMs();
  const degraded = (why: string): DegradedResult => ({ status: 'pending_manual', referenceToken: '', reason: why.slice(0, 120), degraded: EXTRACTION_UNAVAILABLE });
  // One settled promise, never a rejection: a hung adapter resolves to the outage at the bound,
  // a thrown one resolves to it at once, and a late answer after the bound is discarded.
  return new Promise<DegradedResult>((resolve) => {
    let settled = false;
    const finish = (r: DegradedResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => finish(degraded(`extraction timed out after ${timeoutMs} ms`)), timeoutMs);
    let p: Promise<KycVerificationResult>;
    try { p = call(); } catch (err) { finish(degraded(err instanceof Error ? err.message : String(err))); return; }
    p.then((r) => finish(r), (err) => finish(degraded(err instanceof Error ? err.message : String(err))));
  });
}

/** The breaker for a (country, type): open when the last BREAKER_WINDOW runs violated the schema more than BREAKER_THRESHOLD of the time. */
export async function l3BreakerOpen(db: PrismaClient | Prisma.TransactionClient, profileCode: string): Promise<{ open: boolean; rate: number; runs: number }> {
  const runs = await db.extractionRun.findMany({ where: { profileCode }, orderBy: { startedAt: 'desc' }, take: BREAKER_WINDOW, select: { schemaViolations: true } });
  if (runs.length < BREAKER_WINDOW) return { open: false, rate: 0, runs: runs.length };
  const violating = runs.filter((r) => r.schemaViolations > 0).length;
  const rate = violating / runs.length;
  return { open: rate > BREAKER_THRESHOLD, rate, runs: runs.length };
}

/** Production intake and approvals need the key service; without it the door is closed, never left open in clear. */
export function assertKeyServiceForAccess(what: 'intake' | 'approval'): void {
  if (isProduction() && !getKeyProvider()) {
    throw new AppError(503, 'KEY_SERVICE_UNAVAILABLE', `The document key service is unavailable; ${what} is paused until it returns. Verified actors keep operating.`);
  }
}

/** Something the ladder can observe: a provider whose next call throws or hangs (tests). */
export function degradedProvider(base: KycProvider, mode: 'throw' | 'hang'): KycProvider {
  const fail = () => (mode === 'throw' ? Promise.reject(new Error('extraction service down')) : new Promise<never>(() => undefined));
  return { ...base, engine: base.engine, verifyIdentity: () => fail(), verifyDocument: () => fail(), getStatus: base.getStatus.bind(base) };
}
