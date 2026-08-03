import { createHash } from 'crypto';
import type { FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { QrLookup, ScanVerdict } from './qr-codes';
import { sanitizeSrc, sanitizeTemplate } from './qr-codes';

// ---------------------------------------------------------------------------
// Scan logging — the analytics spine, fire-and-forget by construction. A scan
// must NEVER block on (or fail because of) analytics: the resolver pushes into
// a bounded in-process buffer and redirects immediately; a timer batch-inserts.
// Above SCAN_LOG_QUEUE_MAX the queue sheds new events and counts the loss —
// under a viral-vendor burst the scan page never slows, and lost analytics are
// counted, not hidden. Rows are PII-free: hashed IP under a DAILY rotating
// derivation (unlinkable across days — DPA), hashed UA, coarse device fields.
// ---------------------------------------------------------------------------

const QUEUE_MAX = Math.max(100, Number(process.env['SCAN_LOG_QUEUE_MAX'] ?? 10_000));
const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_BATCH = 500;

/** Mirrors the identitySalt() contract: required in production, fixed in dev. */
function scanIpSalt(): string {
  const salt = process.env['SCAN_IP_SALT'];
  if (!salt) {
    if (process.env['NODE_ENV'] === 'production') throw new Error('SCAN_IP_SALT is required in production');
    return 'dev-scan-ip-salt';
  }
  return salt;
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

let queue: PendingScanEvent[] = [];
let lostTotal = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let client: PrismaClient | null = null;

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
  if (queue.length >= QUEUE_MAX) {
    lostTotal += 1;
    return;
  }
  queue.push(event);
}

async function flush(): Promise<void> {
  if (!client || queue.length === 0) return;
  const batch = queue.splice(0, FLUSH_BATCH);
  try {
    await client.scanEvent.createMany({ data: batch });
  } catch {
    // Analytics never takes the request path down with it; a failed batch is
    // shed-and-counted exactly like queue overflow.
    lostTotal += batch.length;
  }
}

export function startScanLog(prisma: PrismaClient): void {
  client = prisma;
  if (timer) return;
  timer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  timer.unref();
}

/** Drains everything now — tests and shutdown call this for determinism. */
export async function flushScanLog(): Promise<void> {
  while (client && queue.length > 0) await flush();
}

export async function stopScanLog(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  await flushScanLog();
  client = null;
}

/** Test seam only. */
export function resetScanLogForTests(): void {
  queue = [];
  lostTotal = 0;
}
