import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { uploadScanStates } from './upload-scan-debt';

/**
 * [Row 312 · COORD rulings 23 Oct 01:03Z (admins) + 01:28Z (customers and riders)] A PHOTO STORED WHILE
 * THE SCANNER WAS DOWN IS SHOWN TO NO ONE BEFORE A CLEAN SCAN.
 *
 * Under MALWARE_SCAN_BYPASS=1 a mover's vehicle photo is stored unscanned and owed a rescan. Like a
 * verification document (ruling (a)), it is not shown before that rescan answers CLEAN: in EVERY API
 * response (admin, customer, rider, driver, store, public) and every order-room socket event, at any
 * depth, a photo field whose file is still owed a scan (AWAITING), failed it (FAILED: never shown) or is
 * gone (GONE) becomes null, and the state field beside it says which. The client-written
 * `profilePhotoUrl` pointer is held to the same rule, since it can name any stored upload. The plate,
 * the vehicle and the person's own photo (an avatar upload, which the bypass never covers) are untouched.
 * One query per payload; a lookup error withholds every photo in it (AWAITING).
 *
 * RULE (REVIEW-G S4): this is a preSerialization hook, so it sees only objects. A body sent pre-serialised
 * (a JSON string, a Buffer or the raw response stream) or a direct socket emit would skip it: send an
 * object and publish order events through emitToOrderRoom. A census in vehicle-photo-scan.unit.test.ts
 * fails on either. Measured (REVIEW-F S4-2): p95 0.28 ms on a 500-item market list, 0.37 ms on a
 * 200-order board, 0.61 ms when photos are present (one query); serialising the same payload costs ~3 ms.
 */
/** The photo fields and the state field written beside each (own keys only: never a prototype name). */
const stateFieldOf = (key: string): string | null =>
  key === 'vehiclePhotoUrl' ? 'vehiclePhotoScan' : key === 'profilePhotoUrl' ? 'profilePhotoScan' : null;

/** The same object test as the legacy pointer walker (admin/document-reviewer.ts): a null prototype counts. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** [REVIEW-F S4-2 · speed] Runs on EVERY response, so it allocates nothing per node: a plain recursive
 *  read of own keys. A response payload is acyclic (it is about to be serialised); a cycle would overflow
 *  here and the request fails rather than serving anything (fail closed). */
function collect(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const item = value[i]; if (item !== null && typeof item === 'object') collect(item, out); }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const child = value[key];
    if (typeof child === 'string') { if (child && stateFieldOf(key)) out.add(child); }
    else if (child !== null && typeof child === 'object') collect(child, out);
  }
}

export async function withVehiclePhotosScanned<T>(prisma: Pick<PrismaClient, 'uploadScanDebt'>, payload: T): Promise<T> {
  const photos = new Set<string>();
  collect(payload, photos);
  if (photos.size === 0) return payload;
  const states = await uploadScanStates(prisma, [...photos]);
  if ([...states.values()].every((s) => s === 'SCANNED')) return payload;
  const seen = new WeakMap<object, unknown>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (seen.has(value)) return seen.get(value);
      const out = value.map(walk);
      seen.set(value, out);
      return out;
    }
    if (!isPlainObject(value)) return value;
    if (seen.has(value)) return seen.get(value);
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, child] of Object.entries(value)) {
      const stateField = stateFieldOf(key);
      if (stateField && typeof child === 'string' && child) {
        const state = states.get(child) ?? 'AWAITING';
        if (state === 'SCANNED') { out[key] = child; continue; }
        out[key] = null;
        out[stateField] = state;
        continue;
      }
      out[key] = walk(child);
    }
    return out;
  };
  return walk(payload) as T;
}

/** Called on the ROOT instance (app.ts), before any route: every response passes through the filter. */
export function registerUploadPhotoScan(app: FastifyInstance): void {
  app.addHook('preSerialization', async (_request, _reply, payload: unknown) => withVehiclePhotosScanned(app.prisma, payload));
}
