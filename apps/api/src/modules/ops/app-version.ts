import type { PrismaClient } from '@prisma/client';

/**
 * [Row 3 · force update] The oldest phone build Swift still serves, per platform.
 *
 * An OPS setting, deliberately NOT part of the platform spine: these two
 * PlatformConfig keys are absent from desiredPlatformConfig(), so the signed
 * seed never plans, writes or reverts them, and changing them needs no new
 * owner-signed seed. Ops set them from the admin console's config page
 * (PUT /admin/config/:key — super-admin, second approver, audited in the same
 * transaction), with no deploy.
 *
 * Phones from build 12 on ask GET /api/v1/public/app-version when they open
 * and when they come back to the screen; a phone whose own build number is
 * below the platform's minimum shows a blocking "Update Swift" screen with its
 * store link. Builds 9–11 never ask, and NOTHING on the server refuses a
 * request because of its app version: this answer is advice the newer phones
 * act on, never a gate the API enforces.
 *
 * The values compare against the phone's native build number, which is what
 * each store counts: the iPhone's build (CFBundleVersion: 9, 10, 11, 12 …)
 * and Android's versionCode (5, 6, 7, 8 …). Every Swift binary is version
 * 1.0.0, so the marketing version cannot tell them apart.
 */
export const MIN_BUILD_KEYS = {
  ios: 'app_min_build_ios',
  android: 'app_min_build_android',
} as const;

export type AppPlatform = keyof typeof MIN_BUILD_KEYS;

/** A typo cannot become a minimum no build will ever reach. */
export const MAX_MIN_BUILD = 100_000;

export interface AppVersionPolicy {
  ios: { minBuild: number | null };
  android: { minBuild: number | null };
}

/**
 * A stored value as a minimum build, or null for "no minimum". Only a whole
 * number from 1 to MAX_MIN_BUILD is a minimum (a number, or digits in a
 * string). 0, an empty or cleared field, a fraction, a negative, anything out
 * of range or of another shape means no minimum: a malformed row must never
 * block every phone.
 */
export function minimumBuildOf(value: unknown): number | null {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_MIN_BUILD) return null;
  return n;
}

/** Both platforms' minimums, read fresh (no cache: a change applies at once). */
export async function readAppVersionPolicy(prisma: Pick<PrismaClient, 'platformConfig'>): Promise<AppVersionPolicy> {
  const rows = await prisma.platformConfig.findMany({
    where: { key: { in: [MIN_BUILD_KEYS.ios, MIN_BUILD_KEYS.android] } },
    select: { key: true, value: true },
  });
  const valueOf = (key: string) => rows.find((r) => r.key === key)?.value;
  return {
    ios: { minBuild: minimumBuildOf(valueOf(MIN_BUILD_KEYS.ios)) },
    android: { minBuild: minimumBuildOf(valueOf(MIN_BUILD_KEYS.android)) },
  };
}
