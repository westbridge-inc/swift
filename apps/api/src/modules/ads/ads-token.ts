import { systemPrismaClient } from '../../plugins/prisma';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { isProduction } from '../../utils/runtime-mode';

// Impression token (ads-platform spec §11.3). A v2 token binds a recorded,
// quota-controlled serving decision; ingestion also checks that persisted
// authority. This bounds client reports, without proving a human view or
// changing spend. ADS_EVENT_SECRET stays server-only.

export interface AdTokenPayload {
  v: 1 | 2; // token schema version — legacy unscoped tokens are not billable
  t?: string; // signed tenant of the recorded serve
  i?: string; // persisted random serve identity (v2)
  c: string; // campaignId
  r: string; // creativeId
  p: string; // placementKey
  s: string; // sessionId
  a: string; // signed serve-time principal scope (guest or pseudonymous user)
  e: number; // expiry (epoch ms)
}

function secret(): string {
  const s = process.env['ADS_EVENT_SECRET'];
  if (s && s.length >= 16) return s;
  if (isProduction()) {
    throw new Error('ADS_EVENT_SECRET missing or too short in production');
  }
  return 'dev-ads-event-secret-not-for-production';
}

const b64url = (buf: Buffer) => buf.toString('base64url');

function sign(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

/** A guest token is deliberately usable only by a request with no valid auth.
 *  Authenticated markers are HMACs scoped to the client app session: they do
 *  not expose a raw user id and cannot be joined across app sessions. */
export function adPrincipalScope(userId: string | null, appSessionId: string): string {
  if (!userId) return 'g';
  const digest = createHmac('sha256', secret())
    .update('swift-ad-principal-v1\0')
    .update(userId)
    .update('\0')
    .update(appSessionId)
    .digest('base64url');
  return `u.${digest}`;
}

/** Constant-time comparison between the token's serve-time principal and the
 *  current request principal. The signed app session is used for recomputing
 *  the marker, so access-token/session rotation for the same user is safe. */
export function adTokenMatchesPrincipal(payload: AdTokenPayload, userId: string | null, authPresented: boolean): boolean {
  // Optional-auth routes intentionally degrade invalid credentials to a guest
  // principal. A guest ad event is nevertheless valid only when the client
  // explicitly omitted Authorization, never when it presented stale/invalid
  // credentials that happened to fail authentication.
  if (!userId && authPresented) return false;
  const expected = Buffer.from(adPrincipalScope(userId, payload.s), 'utf8');
  const actual = Buffer.from(payload.a, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Mint a token for a served creative. `ttlMinutes` default 15 (§11.3). */
export function signImpressionToken(
  payload: Omit<AdTokenPayload, 'v' | 'a' | 'e'>,
  userId: string | null,
  now = Date.now(),
  ttlMinutes = 15,
): string {
  const full: AdTokenPayload = {
    v: payload.i ? 2 : 1,
    ...payload,
    a: adPrincipalScope(userId, payload.s),
    e: now + ttlMinutes * 60_000,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(full), 'utf8'));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export type TokenVerdict =
  | { ok: true; payload: AdTokenPayload }
  | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' };

/** Verify a token: signature (constant-time) then expiry. Never throws. */
export function verifyImpressionToken(token: string, now = Date.now()): TokenVerdict {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'MALFORMED' };
  const [payloadB64, sig] = token.split('.', 2);
  if (!payloadB64 || !sig) return { ok: false, reason: 'MALFORMED' };
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (
    typeof payload !== 'object'
    || payload === null
    || !([1, 2].includes((payload as Partial<AdTokenPayload>).v ?? 0))
    || ((payload as Partial<AdTokenPayload>).v === 2 && (typeof (payload as Partial<AdTokenPayload>).i !== 'string' || typeof (payload as Partial<AdTokenPayload>).t !== 'string'))
    || typeof (payload as Partial<AdTokenPayload>).c !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).r !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).p !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).s !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).a !== 'string'
    || typeof (payload as Partial<AdTokenPayload>).e !== 'number'
  ) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const typed = payload as AdTokenPayload;
  if (now > typed.e) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, payload: typed };
}

/** sha256(userId + rotating daily salt) — the pseudonymous user key for
 *  frequency capping and stats. Raw user ids NEVER enter AdEvent (§12.2). The
 *  salt rotates each tenant-local day, so yesterday's hashes don't join to
 *  today's. */
export function userHash(userId: string, dayKey: string): string {
  return createHash('sha256').update(`${userId}:${dayKey}:${secret()}`).digest('hex');
}

/** Signed guest continuity is a quota signal, never proof of a human view. */
export function adIdentity(userId: string | null, guestId?: string): string | null {
  if (!userId && !guestId) return null;
  return createHmac('sha256', secret()).update(`ad-continuity-v2\0${userId ? `user:${userId}` : `guest:${guestId}`}`).digest('hex');
}
export function adNetwork(ip: string): string {
  return createHmac('sha256', secret()).update(`ad-network-v2\0${ip}`).digest('hex');
}
export function issueAdGuest(now = Date.now()): string {
  const value = `${randomBytes(24).toString('base64url')}.${now + 86400_000}`;
  return `${value}.${sign(value)}`;
}
export function readAdGuest(cookie: string | undefined, now = Date.now()): string | undefined {
  const value = cookie?.split(';').map((p) => p.trim()).find((p) => p.startsWith('swift_ad_guest='))?.slice('swift_ad_guest='.length);
  if (!value || value.length > 160) return undefined;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{32}$/.test(parts[0]!)) return undefined;
  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 86400_000) return undefined;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  const actual = Buffer.from(parts[2]!);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? parts[0] : undefined;
}

/** Bounded retention: one invocation deletes at most 200 expired rows per table. */
export async function cleanupAdAuthorities(prisma: PrismaClient, now = new Date(), tenantId?: string): Promise<void> {
  const db = tenantId ? prisma : systemPrismaClient() ?? prisma;
  await db.$transaction(async (tx) => {
    if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    const scope = tenantId ? Prisma.sql`AND "tenantId" = ${tenantId}` : Prisma.empty;
    await tx.$executeRaw(Prisma.sql`DELETE FROM "ad_serve_grants" WHERE "id" IN (
      SELECT "id" FROM "ad_serve_grants" WHERE "expiresAt" <= ${now} ${scope} ORDER BY "expiresAt", "id" LIMIT 200
    )`);
    await tx.$executeRaw(Prisma.sql`DELETE FROM "ad_serve_budgets" WHERE "key" IN (
      SELECT "key" FROM "ad_serve_budgets" WHERE "expiresAt" <= ${now} ORDER BY "expiresAt", "key" LIMIT 200
    )`);
  });
}

/** Revalidate a paid serving decision and reserve both budgets before allocation. */
export async function recordAdServe(prisma: PrismaClient, input: {
  tenantId: string; campaignId: string; creativeId: string; placementKey: string;
  principalHash: string; networkHash: string; week: Date; city: string;
}, now: Date): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${input.tenantId}, true)`;
    const creatives = await tx.$queryRaw<Array<{ kind: string; durationSeconds: unknown }>>(Prisma.sql`
      SELECT cr."kind"::text AS kind, cr."durationSeconds" FROM "ad_creatives" cr
      JOIN "ad_campaigns" c ON c."id" = cr."campaignId"
      JOIN "ad_placements" p ON p."id" = c."placementId"
      WHERE c."id" = ${input.campaignId} AND cr."id" = ${input.creativeId}
        AND c."tenantId" = ${input.tenantId} AND p."tenantId" = ${input.tenantId}
        AND p."key" = ${input.placementKey} AND p."active" = true
        AND c."status"::text = 'LIVE' AND cr."status"::text = 'APPROVED' AND cr."transcodeStatus"::text = 'READY'
        AND EXISTS (SELECT 1 FROM "ad_bookings" b WHERE b."campaignId" = c."id"
          AND b."placementId" = p."id" AND b."status"::text = 'CONFIRMED'
          AND b."weekStart" = ${input.week} AND b."city" IN (${input.city}, '*'))
      FOR KEY SHARE OF c, cr
    `);
    const creative = creatives[0];
    if (!creative) return null;
    const hour = Math.floor(now.getTime() / 3600_000);
    // Lock order is always network then principal. A refused network allocates
    // no new principal row; a principal refusal may consume a network attempt,
    // but it allocates no grant and no metric authority.
    for (const [prefix, identity, cap] of [['network', input.networkHash, 100], ['principal', input.principalHash, 20]] as const) {
      const key = `${prefix}:${hour}:${identity}`;
      const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        INSERT INTO "ad_serve_budgets" ("key", "count", "expiresAt") VALUES (${key}, 1, ${new Date((hour + 2) * 3600_000)})
        ON CONFLICT ("key") DO UPDATE SET "count" = "ad_serve_budgets"."count" + 1
        WHERE "ad_serve_budgets"."count" < ${cap} RETURNING "count"
      `);
      if (!rows.length) return null;
    }
    const id = randomBytes(24).toString('base64url');
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ad_serve_grants" ("id", "tenantId", "campaignId", "creativeId", "placementKey", "principalHash", "issuedAt", "expiresAt", "kind", "durationMs")
      VALUES (${id}, ${input.tenantId}, ${input.campaignId}, ${input.creativeId}, ${input.placementKey}, ${input.principalHash}, ${now}, ${new Date(now.getTime() + 15 * 60_000)}, ${creative.kind}, ${Math.max(0, Math.floor(Number(creative.durationSeconds ?? 0) * 1000))})
    `);
    return id;
  });
}
