import type { PrismaClient, Prisma } from '@prisma/client';
import { log } from '../../utils/logger';

/**
 * [ALGO Band 0.3 / 0.5] The decision log and the shadow harness.
 *
 * Every algorithm that ranks, prices, flags or gates writes ONE row per
 * decision: the outcome, the sentence a Guyanese rider would accept as the
 * reason (law L9), the exact inputs and the config version. That row is the
 * appeal surface, the debugging surface and the founder's evidence at once.
 *
 * The shadow harness is how an algorithm earns the right to go live: it runs
 * the new logic, writes what it WOULD have decided as a shadow row, and
 * returns the CURRENT production answer unchanged. Promotion is two lines —
 * stop calling `shadow`, start calling the algorithm — and needs a founder
 * decision plus ≥2 weeks of rows (batching's standard, applied to all).
 *
 * Kill switches (Band 0.6): every algorithm that goes live registers
 * `'<ALG-nn>.enabled'` in ALGO_DEFAULTS with its CURRENT behaviour as the
 * default, so flag-off is byte-identical to the day before it shipped.
 *
 * Recording never throws on a database failure — a decision log that could
 * take the decision down with it would be worse than a gap in the log. An
 * EMPTY sentence does throw, synchronously: that is a programming error, and
 * it is caught in the first test that exercises the caller.
 */

export type DecisionSubjectType = 'ORDER' | 'RIDER' | 'DRIVER' | 'VENDOR' | 'CUSTOMER' | 'ITEM';

export interface DecisionInput {
  /** "ALG-18" — the algorithm document's id, never a nickname. */
  algo: string;
  subjectType: DecisionSubjectType;
  subjectId: string;
  /** The decision, one token: "EXCLUDED", "PRICED", "FLAGGED"… */
  outcome: string;
  /** The human sentence. Non-empty, one sentence, ≤ 240 characters. */
  sentence: string;
  /** The exact values that decided it. */
  inputs: Record<string, unknown>;
  configVersion?: number;
  shadow?: boolean;
  /** Defaults to the platform tenant; job-time callers pass the subject's. */
  tenantId?: string;
}

export const SHADOW_RETENTION_DAYS = 90;
export const LIVE_RETENTION_DAYS = 400;
export const MAX_SENTENCE_LENGTH = 240;

export function killSwitchKey(algo: string): `${string}.enabled` {
  return `${algo}.enabled`;
}

function assertSentence(sentence: string): string {
  const s = sentence.trim();
  if (!s) throw new TypeError('AlgoDecision needs a sentence — the reason a rider would accept (L9)');
  if (s.length > MAX_SENTENCE_LENGTH) throw new TypeError(`AlgoDecision sentence is ${s.length} chars; one sentence, ≤ ${MAX_SENTENCE_LENGTH}`);
  return s;
}

/** Write one decision. Returns the row id, or null when the database refused
 *  — logged, never thrown, so the decision itself is never lost to its log. */
export async function recordDecision(prisma: PrismaClient | Prisma.TransactionClient, d: DecisionInput): Promise<string | null> {
  const sentence = assertSentence(d.sentence);
  try {
    const row = await prisma.algoDecision.create({
      data: {
        ...(d.tenantId ? { tenantId: d.tenantId } : {}),
        algo: d.algo,
        subjectType: d.subjectType,
        subjectId: d.subjectId,
        outcome: d.outcome,
        sentence,
        inputs: d.inputs as Prisma.InputJsonValue,
        configVersion: d.configVersion ?? 0,
        shadow: d.shadow ?? false,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    log().warn({ err, algo: d.algo, subjectType: d.subjectType, subjectId: d.subjectId }, 'algo: decision not recorded');
    return null;
  }
}

export type ShadowSpec = Pick<DecisionInput, 'algo' | 'subjectType' | 'subjectId' | 'configVersion' | 'tenantId'>;
export type ShadowResult = Pick<DecisionInput, 'outcome' | 'sentence' | 'inputs'>;

/**
 * Run `produce` (the algorithm that is not yet live), record what it would
 * have decided as a shadow row, and return `current` — production's answer —
 * UNCHANGED. A throwing algorithm is logged and returns `current` too: shadow
 * mode can never change or break what a person sees.
 */
export async function shadow<T>(
  prisma: PrismaClient | Prisma.TransactionClient,
  spec: ShadowSpec,
  produce: () => Promise<ShadowResult> | ShadowResult,
  current: T,
): Promise<T> {
  try {
    const would = await produce();
    await recordDecision(prisma, { ...spec, ...would, shadow: true });
  } catch (err) {
    log().warn({ err, algo: spec.algo, subjectType: spec.subjectType, subjectId: spec.subjectId }, 'algo: shadow run failed — production answer unchanged');
  }
  return current;
}

/** Retention, by class: shadow rows at 90 days, live rows at 400. */
export async function purgeAlgoDecisions(prisma: PrismaClient, now = new Date()): Promise<{ shadow: number; live: number }> {
  const DAY = 24 * 60 * 60 * 1000;
  const shadowBefore = new Date(now.getTime() - SHADOW_RETENTION_DAYS * DAY);
  const liveBefore = new Date(now.getTime() - LIVE_RETENTION_DAYS * DAY);
  const [s, l] = await Promise.all([
    prisma.algoDecision.deleteMany({ where: { shadow: true, createdAt: { lt: shadowBefore } } }),
    prisma.algoDecision.deleteMany({ where: { shadow: false, createdAt: { lt: liveBefore } } }),
  ]);
  return { shadow: s.count, live: l.count };
}
