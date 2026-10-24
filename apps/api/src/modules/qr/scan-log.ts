import { createHash, randomUUID } from 'crypto';
import type { FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { QrLookup, ScanVerdict } from './qr-codes';
import { sanitizeSrc, sanitizeTemplate } from './qr-codes';
import { qrSalt } from './qr-config';
import { runAsSystem } from '../../plugins/tenant-context';

// ---------------------------------------------------------------------------
// Scan logging — the analytics spine, fire-and-forget by construction. A scan
// must NEVER block on (or fail because of) analytics: the resolver pushes into
// a bounded in-process buffer and redirects immediately; a timer batch-inserts.
// Above SCAN_LOG_QUEUE_MAX the queue sheds new events and counts the loss —
// under a viral-vendor burst the scan page never slows, and lost analytics are
// counted, not hidden. Rows are PII-free: hashed IP under a DAILY rotating
// derivation (unlinkable across days — DPA), hashed UA, coarse device fields.
// ---------------------------------------------------------------------------

const configuredMax = Number(process.env['SCAN_LOG_QUEUE_MAX'] ?? 10_000);
const QUEUE_MAX = Number.isSafeInteger(configuredMax) && configuredMax >= 100 ? configuredMax : 10_000;
const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_BATCH = 500;
const WRITE_ATTEMPTS = 3;

/** Mirrors the identitySalt() contract: required in production, fixed in dev. */
function scanIpSalt(): string {
  return qrSalt('SCAN_IP_SALT');
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Funnel writers outside the resolver (e.g. INSTALL_TAP) share the hashers. */
export function hashUa(ua: string): string {
  return sha256(ua);
}

/** sha256(ip | UTC-day | salt): the day term rotates the derivation at 00:00
 *  UTC, so the same phone hashes differently tomorrow (per-day uniques work,
 *  cross-day tracking cannot). */
export function hashScanIp(ip: string, now: Date): string {
  return sha256(`${ip}|${now.toISOString().slice(0, 10)}|${scanIpSalt()}`);
}

/** Coarse-only UA parse — enough for the funnel, useless for fingerprinting. */
export function parseUserAgent(ua: string | undefined): { osFamily: string; deviceClass: string } {
  const s = (ua ?? '').toLowerCase();
  if (/ipad/.test(s)) return { osFamily: 'ios', deviceClass: 'tablet' };
  if (/iphone|ipod/.test(s)) return { osFamily: 'ios', deviceClass: 'phone' };
  if (/android/.test(s)) return { osFamily: 'android', deviceClass: /mobile/.test(s) ? 'phone' : 'tablet' };
  if (s.length === 0) return { osFamily: 'other', deviceClass: 'desktop' };
  return { osFamily: 'desktop', deviceClass: 'desktop' };
}

type PendingScanEvent = Prisma.ScanEventCreateManyInput;

type BufferedScan = { event: PendingScanEvent; attempts: number };
let queue: BufferedScan[] = [];
let lostTotal = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let client: PrismaClient | null = null;
let draining: Promise<void> | null = null;
let inFlight = 0;
let stopping = false;

/** Observability hook (Part 17): qr_scan_events_lost_total. */
export function scanEventsLostTotal(): number {
  return lostTotal;
}

export function buildScanEvent(
  request: FastifyRequest,
  qr: (QrLookup & { id: string; tenantId: string }) | null,
  decision: ScanVerdict | 'APP_OPEN_ASSUMED',
): PendingScanEvent {
  const now = new Date();
  const ua = request.headers['user-agent'];
  const { osFamily, deviceClass } = parseUserAgent(typeof ua === 'string' ? ua : undefined);
  const query = (request.query ?? {}) as Record<string, unknown>;
  const country = request.headers['cf-ipcountry'];
  return {
    tenantId: qr?.tenantId ?? 'swift-default',
    qrCodeId: qr?.id ?? null,
    occurredAt: now,
    decision,
    src: sanitizeSrc(query['src']) ?? 'qr',
    template: sanitizeTemplate(query['t']),
    osFamily,
    deviceClass,
    uaHash: typeof ua === 'string' && ua.length > 0 ? sha256(ua) : null,
    ipHash: request.ip ? hashScanIp(request.ip, now) : null,
    country: typeof country === 'string' ? country.slice(0, 2).toUpperCase() : null,
  };
}

/** Fire-and-forget enqueue. Never throws, never awaits, sheds above the cap. */
export function enqueueScanEvent(event: PendingScanEvent): void {
  if (stopping || queue.length + inFlight >= QUEUE_MAX) {
    lostTotal += 1;
    return;
  }
  // Retries after an unknown commit reuse the same ID. scan_events has no
  // other unique key; ON CONFLICT therefore only deduplicates this event.
  queue.push({ event: { ...event, id: randomUUID() }, attempts: 0 });
}

/** Construction can throw before enqueue (e.g. a broken hash setting).
 * Keep that failure separate from destination/candidate determination. */
export function recordScanEvent(build: () => PendingScanEvent): void {
  try { enqueueScanEvent(build()); } catch { lostTotal += 1; }
}

function isRowRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  // A connection/timeout/unknown-commit failure is never evidence that a
  // particular row is bad. Only definite data refusals may be subdivided.
  return code === 'P2003' || code === 'P2011' || code === 'P2014'
    || error.message.includes('[STA-1 lineage]') || error.message.includes('STA-1 lineage refused');
}

async function writeBatch(prisma: PrismaClient, batch: BufferedScan[]): Promise<BufferedScan[]> {
  try {
    // createMany is one atomic statement. A rejected statement persists none
    // of its rows; each retry keeps the original tenant and physical QR ID.
    await prisma.scanEvent.createMany({ data: batch.map(row => row.event), skipDuplicates: true });
    return [];
  } catch (error) {
    if (isRowRefusal(error)) {
      if (batch.length === 1) { lostTotal += 1; return []; }
      const middle = Math.floor(batch.length / 2);
      // Sequential subdivision also prevents unbounded writer concurrency.
      return [...await writeBatch(prisma, batch.slice(0, middle)), ...await writeBatch(prisma, batch.slice(middle))];
    }
    return batch.filter(row => {
      row.attempts += 1;
      if (row.attempts < WRITE_ATTEMPTS) return true;
      lostTotal += 1;
      return false;
    });
  }
}

async function flush(): Promise<void> {
  const prisma = client;
  if (!prisma || queue.length === 0) return;
  const batch = queue.splice(0, FLUSH_BATCH);
  inFlight = batch.length;
  try {
    // [L01 · tenant wall] A flush writes events of every tenant (each row
    // carries its own tenantId, taken from its QR code): named system work, not
    // an unbound write, and never stamped with whatever tenant was ambient.
    const retry = await runAsSystem('qr:scan-log-flush', () => writeBatch(prisma, batch));
    queue.unshift(...retry);
  } finally { inFlight = 0; }
}

async function drain(all: boolean): Promise<void> {
  if (draining) {
    await draining;
    // Another waiter may already have started the next write and removed its
    // rows from queue. Shutdown must wait for that in-flight write as well.
    if (all) await drain(true);
    return;
  }
  const work = (async () => {
    do { await flush(); } while (all && client && queue.length > 0);
  })();
  draining = work;
  try { await work; } finally { if (draining === work) draining = null; }
}

export function startScanLog(prisma: PrismaClient): void {
  client = prisma;
  stopping = false;
  if (timer) return;
  timer = setInterval(() => { if (!draining) void drain(false); }, FLUSH_INTERVAL_MS);
  timer.unref();
}

/** Drains everything now — tests and shutdown call this for determinism. */
export async function flushScanLog(): Promise<void> {
  await drain(true);
}

export async function stopScanLog(): Promise<void> {
  stopping = true;
  if (timer) { clearInterval(timer); timer = null; }
  await flushScanLog();
  client = null;
}

/** Test seam only. */
export function resetScanLogForTests(): void {
  queue = [];
  lostTotal = 0;
  stopping = false;
}
