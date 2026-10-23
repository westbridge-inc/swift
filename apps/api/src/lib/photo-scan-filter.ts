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
 */
const FIELDS: Readonly<Record<string, string>> = { vehiclePhotoUrl: 'vehiclePhotoScan', profilePhotoUrl: 'profilePhotoScan' };

/** The same object test as the legacy pointer walker (admin/document-reviewer.ts): a null prototype counts. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function collect(value: unknown, out: Set<string>, seen: WeakSet<object>): void {
  if (Array.isArray(value)) { if (seen.has(value)) return; seen.add(value); for (const item of value) collect(item, out, seen); return; }
  if (!isPlainObject(value) || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key in FIELDS && typeof child === 'string' && child) out.add(child);
    else collect(child, out, seen);
  }
}

export async function withVehiclePhotosScanned<T>(prisma: Pick<PrismaClient, 'uploadScanDebt'>, payload: T): Promise<T> {
  const photos = new Set<string>();
  collect(payload, photos, new WeakSet());
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
      if (key in FIELDS && typeof child === 'string' && child) {
        const state = states.get(child) ?? 'AWAITING';
        if (state === 'SCANNED') { out[key] = child; continue; }
        out[key] = null;
        out[FIELDS[key]!] = state;
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
