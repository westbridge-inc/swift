import type { PrismaClient } from '@prisma/client';
import { uploadScanStates } from '../../lib/upload-scan-debt';

/**
 * [Row 312 · COORD ruling 23 Oct 01:03Z] A VEHICLE PHOTO REACHES ADMINS ONLY AFTER A CLEAN SCAN.
 *
 * Under MALWARE_SCAN_BYPASS=1 a mover's vehicle photo is stored unscanned and owed a rescan. Like a
 * verification document (ruling (a)), it is not shown to staff before that rescan answers CLEAN: in
 * EVERY admin response, at any depth, a `vehiclePhotoUrl` still owed a scan (AWAITING) or that failed
 * it (FAILED, never shown), or whose file is gone (GONE), is replaced by null, and `vehiclePhotoScan`
 * beside it says which. One query per response; a lookup error withholds every photo in it (AWAITING).
 */
const FIELD = 'vehiclePhotoUrl';
const STATE_FIELD = 'vehiclePhotoScan';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function collect(value: unknown, out: Set<string>, seen: WeakSet<object>): void {
  if (Array.isArray(value)) { if (seen.has(value)) return; seen.add(value); for (const item of value) collect(item, out, seen); return; }
  if (!isPlainObject(value) || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === FIELD && typeof child === 'string' && child) out.add(child);
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
      if (key === FIELD && typeof child === 'string' && child) {
        const state = states.get(child) ?? 'AWAITING';
        if (state === 'SCANNED') { out[key] = child; continue; }
        out[key] = null;
        out[STATE_FIELD] = state;
        continue;
      }
      out[key] = walk(child);
    }
    return out;
  };
  return walk(payload) as T;
}
