import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { recordDecision, shadow, purgeAlgoDecisions, killSwitchKey, SHADOW_RETENTION_DAYS, LIVE_RETENTION_DAYS } from '../modules/algo/decisions';

// ---------------------------------------------------------------------------
// [ALGO Band 0.3 / 0.5] The decision log and the shadow harness.
//
// What is graded: a decision is one row with a sentence a rider would accept;
// the shadow harness returns production's answer UNCHANGED whatever the new
// algorithm does — including throwing — while writing what it would have
// decided; the log can never take a decision down with it; and retention
// treats shadow evidence (90 days) differently from rows that touched a
// person's money (400 days).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const ALGO = `ALG-TEST-${nanoid(6)}`;

let app: FastifyInstance;

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.prisma.algoDecision.deleteMany({ where: { algo: { startsWith: 'ALG-TEST-' } } });
  await app.close();
});

describe('one decision, one row, one sentence', () => {
  it('records outcome, sentence, inputs and config version, on the platform tenant by default', async () => {
    const id = await recordDecision(app.prisma, {
      algo: ALGO, subjectType: 'ORDER', subjectId: 'o1', outcome: 'PRICED',
      sentence: 'Delivery fee is $500: 2.1 km at the Georgetown rate.',
      inputs: { km: 2.1, rate: 'GY-standard' }, configVersion: 3,
    });
    expect(id).toBeTruthy();
    const row = await app.prisma.algoDecision.findUniqueOrThrow({ where: { id: id! } });
    expect(row).toMatchObject({ tenantId: 'swift-default', algo: ALGO, subjectType: 'ORDER', subjectId: 'o1', outcome: 'PRICED', configVersion: 3, shadow: false });
    expect(row.inputs).toEqual({ km: 2.1, rate: 'GY-standard' });
  });

  it('an empty sentence is a programming error — it throws before anything is written', async () => {
    await expect(recordDecision(app.prisma, { algo: ALGO, subjectType: 'RIDER', subjectId: 'r1', outcome: 'X', sentence: '   ', inputs: {} })).rejects.toThrow(/sentence/);
    await expect(recordDecision(app.prisma, { algo: ALGO, subjectType: 'RIDER', subjectId: 'r1', outcome: 'X', sentence: 'x'.repeat(241), inputs: {} })).rejects.toThrow(/one sentence/);
    expect(await app.prisma.algoDecision.count({ where: { algo: ALGO, subjectId: 'r1' } })).toBe(0);
  });

  it('a database refusal is logged and returns null — the log never takes the decision down', async () => {
    const broken = { algoDecision: { create: vi.fn().mockRejectedValue(new Error('connection lost')) } } as any;
    await expect(recordDecision(broken, { algo: ALGO, subjectType: 'ORDER', subjectId: 'o2', outcome: 'X', sentence: 'A real sentence.', inputs: {} })).resolves.toBeNull();
  });

  it('the kill switch key follows one spelling', () => {
    expect(killSwitchKey('ALG-18')).toBe('ALG-18.enabled');
  });
});

describe('the shadow harness', () => {
  it('returns the CURRENT answer unchanged and writes what the new algorithm would have decided', async () => {
    const current = { fee: 500, source: 'quote' };
    const out = await shadow(app.prisma, { algo: ALGO, subjectType: 'ORDER', subjectId: 'o3', configVersion: 1 }, () => ({
      outcome: 'WOULD_PRICE_620', sentence: 'The routed distance is 2.6 km, not the 2.1 km quoted.', inputs: { routedKm: 2.6 },
    }), current);
    expect(out).toBe(current);
    const row = await app.prisma.algoDecision.findFirst({ where: { algo: ALGO, subjectId: 'o3' } });
    expect(row).toMatchObject({ shadow: true, outcome: 'WOULD_PRICE_620', configVersion: 1 });
  });

  it('a throwing algorithm changes nothing a person sees — production answer returned, nothing written', async () => {
    const current = 'production';
    const out = await shadow(app.prisma, { algo: ALGO, subjectType: 'ORDER', subjectId: 'o4' }, () => { throw new Error('new maths exploded'); }, current);
    expect(out).toBe('production');
    expect(await app.prisma.algoDecision.count({ where: { algo: ALGO, subjectId: 'o4' } })).toBe(0);
  });
});

describe('retention', () => {
  it('shadow rows expire at 90 days, live rows at 400 — and nothing younger is touched', async () => {
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const mk = (subjectId: string, shadowRow: boolean, ageDays: number) => app.prisma.algoDecision.create({
      data: { algo: ALGO, subjectType: 'ORDER', subjectId, outcome: 'X', sentence: 'Kept for the test.', inputs: {}, shadow: shadowRow, createdAt: at(ageDays) },
    });
    await Promise.all([
      mk('old-shadow', true, SHADOW_RETENTION_DAYS + 1), mk('young-shadow', true, SHADOW_RETENTION_DAYS - 1),
      mk('old-live', false, LIVE_RETENTION_DAYS + 1), mk('middle-live', false, SHADOW_RETENTION_DAYS + 1), mk('young-live', false, 1),
    ]);
    const purged = await purgeAlgoDecisions(app.prisma, now);
    expect(purged.shadow).toBeGreaterThanOrEqual(1);
    expect(purged.live).toBeGreaterThanOrEqual(1);
    const left = (await app.prisma.algoDecision.findMany({ where: { algo: ALGO, subjectId: { in: ['old-shadow', 'young-shadow', 'old-live', 'middle-live', 'young-live'] } }, select: { subjectId: true } })).map((r) => r.subjectId).sort();
    // A live row older than the SHADOW limit but younger than the LIVE limit survives — money evidence is not shadow evidence.
    expect(left).toEqual(['middle-live', 'young-live', 'young-shadow']);
  });
});
