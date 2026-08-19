import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  runScan, notifyPending, classify, parseEntries,
  type WatchSource, type FetchLike, type NotifyChannels,
} from '../modules/compliance/commencement-watch';

// [DCR-1 Part III] The watch observes and alerts, never acts. The negative
// test (the REAL DICA commencement order, the closest look-alike Gazette
// listing that must NOT fire) is as important as the positive.
let app: FastifyInstance;
const runId = nanoid(6);
const S1: WatchSource = { id: `s1-${runId}`, url: 'https://gazette.test/pubs', trust: 'S1' };
const S2: WatchSource = { id: `s2-${runId}`, url: 'https://parliament.test/acts', trust: 'S2' };

const DICA_NEGATIVE = 'Order No. 73 of 2026 - The Digital Identity Card Act 2023 (Commencement) Order 2026';
const DPA_POSITIVE = 'Order No. 12 of 2027 - The Data Protection Act 2023 (Commencement) Order 2027';
const REGS_POSITIVE = 'The Data Protection (General) Regulations 2027';

function page(titles: string[]): string {
  return `<html><body><ul>${titles.map((t, i) => `<li><a href="/doc/${i}">${t}</a></li>`).join('')}</ul></body></html>`;
}

function fetchReturning(map: Record<string, { status: number; body: string }>): FetchLike {
  return async (url) => {
    const hit = map[url] ?? { status: 404, body: '' };
    return { status: hit.status, text: async () => hit.body };
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.prisma.cwAlert.deleteMany({ where: { sourceId: { contains: runId } } });
  await app.prisma.cwRun.deleteMany({ where: { sourceId: { contains: runId } } });
  await app.close();
});

describe('commencement watch [DCR-1 CW]', () => {
  it('the canonical NEGATIVE: the real DICA commencement order must NOT fire', () => {
    expect(classify({ title: DICA_NEGATIVE, url: null }, 'S1')).toBeNull();
  });

  it('a synthesized DPA order on S1 → exactly ONE CONFIRMED-CANDIDATE COMMENCEMENT', async () => {
    const summaries = await runScan(app.prisma, fetchReturning({
      [S1.url]: { status: 200, body: page([DICA_NEGATIVE, DPA_POSITIVE, 'Appropriation Act 2027']) },
    }), [S1]);
    expect(summaries[0]!.newAlerts).toBe(1);
    const alerts = await app.prisma.cwAlert.findMany({ where: { sourceId: S1.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.eventType).toBe('COMMENCEMENT');
    expect(alerts[0]!.confidence).toBe('CONFIRMED-CANDIDATE');
  });

  it('regulations fixture → REGULATIONS; the same entries re-scanned → ZERO new alerts (dedupe)', async () => {
    const fetcher = fetchReturning({
      [S1.url]: { status: 200, body: page([DPA_POSITIVE, REGS_POSITIVE]) },
    });
    const first = await runScan(app.prisma, fetcher, [S1]);
    expect(first[0]!.newAlerts).toBe(1); // regs new; commencement deduped from prior test
    const again = await runScan(app.prisma, fetcher, [S1]);
    expect(again[0]!.newAlerts).toBe(0);
    const regs = await app.prisma.cwAlert.findMany({ where: { sourceId: S1.id, eventType: 'REGULATIONS' } });
    expect(regs).toHaveLength(1);
  });

  it('S2 (non-Gazette) can only mint SIGNAL, never CONFIRMED-CANDIDATE', async () => {
    await runScan(app.prisma, fetchReturning({
      [S2.url]: { status: 200, body: page([DPA_POSITIVE]) },
    }), [S2]);
    const alert = await app.prisma.cwAlert.findFirstOrThrow({ where: { sourceId: S2.id } });
    expect(alert.confidence).toBe('SIGNAL');
  });

  it('200-with-zero-entries is PARSE_EMPTY — a failure, never a quiet zero', async () => {
    const s = { id: `s1e-${runId}`, url: 'https://gazette.test/empty', trust: 'S1' as const };
    const out = await runScan(app.prisma, fetchReturning({ [s.url]: { status: 200, body: '<html></html>' } }), [s]);
    expect(out[0]!.error).toBe('PARSE_EMPTY');
    const run = await app.prisma.cwRun.findFirstOrThrow({ where: { sourceId: s.id } });
    expect(run.error).toBe('PARSE_EMPTY');
  });

  it('3 consecutive source failures → exactly ONE WATCH_DEGRADED per day', async () => {
    const s = { id: `s1d-${runId}`, url: 'https://gazette.test/down', trust: 'S1' as const };
    const dead = fetchReturning({}); // every fetch 404s
    await runScan(app.prisma, dead, [s]);
    await runScan(app.prisma, dead, [s]);
    await runScan(app.prisma, dead, [s]);
    await runScan(app.prisma, dead, [s]); // 4th failure — still the same day bucket
    const degraded = await app.prisma.cwAlert.findMany({ where: { sourceId: s.id, eventType: 'WATCH_DEGRADED' } });
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.confidence).toBe('SYSTEM');
  });

  it('ZERO alert channels is itself RED: notify throws after recording a SYSTEM alert', async () => {
    const none: NotifyChannels = { webhookUrl: null, emails: [], notifyAdmins: null };
    await expect(notifyPending(app.prisma, none, fetchReturning({}))).rejects.toThrow(/zero alert channels/);
  });

  it('notify delivers pending alerts in-app and stamps notifiedAt; ack stops re-notify', async () => {
    const sent: string[] = [];
    const channels: NotifyChannels = {
      webhookUrl: null, emails: [],
      notifyAdmins: async (title) => { sent.push(title); },
    };
    const n = await notifyPending(app.prisma, channels, fetchReturning({}));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBe(n);
    const unnotified = await app.prisma.cwAlert.count({
      where: { sourceId: { contains: runId }, notifiedAt: null },
    });
    expect(unnotified).toBe(0);
    // Second notify with nothing new and nothing older than a day → nothing.
    expect(await notifyPending(app.prisma, channels, fetchReturning({}))).toBe(0);
  });

  it('parseEntries survives markup inside anchors', () => {
    const entries = parseEntries('<a href="/x"><b>The Data</b> Protection Act 2023 (Commencement) Order</a>');
    expect(entries[0]!.title).toContain('Protection Act');
  });
});
