import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { TRIAL_DAYS } from '../subscription/subscription.service';
import { resolveAvatarUrl } from '../../utils/avatar-url';
import { recordStorageOrphan } from '../../lib/storage-orphans';
import { AppError } from '../../utils/errors';
import { zPhone } from '../../utils/phone';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import { getStorageProvider } from '../../providers/storage/storage-provider';

const sendOtpSchema = z.object({
  phone: zPhone,
});

const verifyOtpSchema = z.object({
  phone: zPhone,
  code: z.string().length(6),
});

const registerSchema = z.object({
  phone: zPhone,
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  email: z.string().email().optional(),
  role: z.enum(['CUSTOMER', 'MOVER', 'VENDOR']).default('CUSTOMER'),
  countryCode: z.string().length(2).default('GY'),
  /// SWIFT-AUD-D9-03: recorded consent. Optional so shipped clients keep
  /// working; CONSENT_REQUIRED=1 enforces it once updated clients are out.
  acceptTerms: z.boolean().optional(),
});

const refreshSchema = z.object({
  // [NR5-01] bounded: refresh tokens are issued at a fixed length — an
  // unbounded string here was the census's uncapped-credential finding.
  refreshToken: z.string().min(1).max(512),
});

const logoutSchema = z.object({
  pushToken: z.string().min(8).max(512).optional(),
});

const refreshLogoutSchema = logoutSchema.extend({
  refreshToken: z.string().min(1).max(512),
});

const passwordLoginSchema = z
  .object({
    phone: zPhone.optional(),
    email: z.string().email().optional(),
    password: z.string().min(8).max(100),
  })
  .refine((d) => d.phone || d.email, { message: 'phone or email is required' });

const setPasswordSchema = z.object({
  password: z.string().min(8).max(100),
});

const resetPasswordSchema = z.object({
  phone: zPhone,
  code: z.string().length(6),
  newPassword: z.string().min(8).max(100),
});

const authRateLimit = {
  config: {
    rateLimit: { max: 10, timeWindow: '1 minute' },
  },
};

const otpRateLimit = {
  config: {
    rateLimit: { max: 5, timeWindow: '1 minute' },
  },
};

export async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService(app);

  app.post('/send-otp', otpRateLimit, async (request, reply) => {
    const body = sendOtpSchema.parse(request.body);
    const result = await authService.sendOtp(body.phone);
    return reply.send({ success: true, data: result });
  });

  app.post('/verify-otp', otpRateLimit, async (request, reply) => {
    const body = verifyOtpSchema.parse(request.body);
    const result = await authService.verifyOtp(body.phone, body.code, {
      deviceId: (request.headers['x-device-id'] as string) || 'unknown',
      deviceType: (request.headers['x-device-type'] as string) || 'unknown',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] || '',
    });
    return reply.send({ success: true, data: result });
  });

  app.post('/register', authRateLimit, async (request, reply) => {
    const body = registerSchema.parse(request.body);
    // Read at request time so the flag flips without a restart (tsx watch) and
    // tests can exercise both modes.
    // [REPORT-021 F-021-05] Fail CLOSED: consent is required unless the
    // compat kill-switch is EXPLICITLY thrown (CONSENT_REQUIRED=0) for a
    // staged old-client window. Missing/typo'd config = enforcement ON.
    if (process.env['CONSENT_REQUIRED'] !== '0' && body.acceptTerms !== true) {
      throw new AppError(400, 'CONSENT_REQUIRED', 'You must accept the Terms of Service and Privacy Policy to create an account');
    }
    const result = await authService.register({
      ...body,
      deviceId: (request.headers['x-device-id'] as string) || null,
      ipAddress: request.ip || null,
    });
    return reply.status(201).send({ success: true, data: result });
  });

  app.post('/refresh', authRateLimit, async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const result = await authService.refreshTokens(body.refreshToken);
    return reply.send({ success: true, data: result });
  });

  app.post('/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = logoutSchema.parse(request.body ?? {});
    const sessionId = request.authSessionId;
    if (!sessionId) {
      throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
    }
    await authService.logout(sessionId, request.user.userId, body.pushToken);
    return reply.send({ success: true });
  });

  /** Logout credential for a locally-cleared client. This intentionally does
   * not use access-token auth: an in-flight refresh may already have rotated
   * the captured access token. Current and immediately-previous refresh
   * credentials resolve to the same locked Session, and every valid/invalid
   * credential receives the same response shape. */
  app.post('/logout/refresh', authRateLimit, async (request, reply) => {
    const body = refreshLogoutSchema.parse(request.body);
    await authService.logoutByRefreshToken(body.refreshToken, body.pushToken);
    return reply.send({ success: true });
  });

  // ── Mandatory signup selfie (master plan §3) ───────────────────────────
  // Camera capture only on the client; the stored image becomes the user's
  // public profile photo (avatar) and unlocks the transact gates (orders,
  // rides, go-online). This is the ONLY writer of avatar/selfieCapturedAt.
  app.post('/selfie', { preHandler: [app.authenticate], ...authRateLimit }, async (request, reply) => {
    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a selfie image');
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      throw new AppError(400, 'BAD_IMAGE_TYPE', 'Only JPEG, PNG, or WebP images are accepted');
    }

    const buffer = await file.toBuffer();
    if (!looksLikeImage(buffer)) {
      throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
    }

    const { url } = await getStorageProvider().upload({
      buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder: `avatars/${request.user.userId}`,
    });

    // [REPORT-022 F-022-21] conditional write: a deletion finishing between
    // auth and this point cannot re-personalize the tombstone with a fresh
    // selfie/avatar. [F-024-08] The object uploads BEFORE this write, so every
    // failure path here must unwind it — a thrown update used to leave an
    // unreferenced personal-data object no sweep could rediscover. Cleanup
    // failures are LOGGED (an orphan must be discoverable, never silent).
    // [F-026-02] Capture the PRIOR pointer before it is overwritten: the old
    // selfie object must be purged (or censused) — a replacement upload used
    // to strand it with no discoverable key.
    const prior = await app.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { avatar: true, tenantId: true },
    });
    let selfieWrite: { count: number };
    try {
      selfieWrite = await app.prisma.user.updateMany({
        where: { id: request.user.userId, status: { notIn: ['DEACTIVATED', 'BANNED', 'SUSPENDED'] } },
        data: { avatar: url, selfieCapturedAt: new Date() },
      });
    } catch (err) {
      await getStorageProvider().delete(url).catch(async (cleanupErr) => {
        app.log.error({ err: cleanupErr, userId: request.user.userId, key: url }, '[F-024-08] selfie cleanup after failed write also failed — orphaned key');
        // [F-026-02] A log line is not a census — the sweep needs the key.
        await recordStorageOrphan(app.prisma, app.log, { key: url, reason: 'SELFIE_UNWIND_DELETE_FAILED', userId: request.user.userId, tenantId: prior?.tenantId });
      });
      throw err;
    }
    if (selfieWrite.count === 0) {
      await getStorageProvider().delete(url).catch(async (cleanupErr) => {
        app.log.error({ err: cleanupErr, userId: request.user.userId, key: url }, '[F-024-08] selfie cleanup after inactive-account refusal failed — orphaned key');
        await recordStorageOrphan(app.prisma, app.log, { key: url, reason: 'SELFIE_UNWIND_DELETE_FAILED', userId: request.user.userId, tenantId: prior?.tenantId });
      });
      throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
    }
    // [F-026-02] The write landed — purge the replaced selfie object. Same
    // legacy-URL guard as account deletion: absolute URLs aren't our keys.
    const oldKey = prior?.avatar;
    if (oldKey && oldKey !== url && !oldKey.startsWith('http://') && !oldKey.startsWith('https://')) {
      await getStorageProvider().delete(oldKey).catch(async (purgeErr) => {
        app.log.error({ err: purgeErr, userId: request.user.userId, key: oldKey }, '[F-026-02] replaced selfie purge failed — censused');
        await recordStorageOrphan(app.prisma, app.log, { key: oldKey, reason: 'REPLACED_SELFIE_DELETE_FAILED', userId: request.user.userId, tenantId: prior?.tenantId });
      });
    }
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: {
        id: true, phone: true, email: true, firstName: true, lastName: true,
        avatar: true, selfieCapturedAt: true, roles: true, activeRole: true, lastMoverRole: true,
        status: true, isPhoneVerified: true, isEmailVerified: true,
        trustLevel: true, createdAt: true, updatedAt: true,
      },
    });

    // [F-026-01] The upload response is the FIRST place a client sees the new
    // avatar — returning the raw S3/R2 key here hands back something it
    // cannot render, moments after a successful upload.
    return reply.send({ success: true, data: { user: { ...user, avatar: await resolveAvatarUrl(user.avatar) } } });
  });

  // ── Email + password (secondary to phone OTP) ──────────────────────────

  app.post('/password/login', authRateLimit, async (request, reply) => {
    const body = passwordLoginSchema.parse(request.body);
    const result = await authService.loginWithPassword(
      { phone: body.phone, email: body.email },
      body.password,
      {
        deviceId: (request.headers['x-device-id'] as string) || 'unknown',
        deviceType: (request.headers['x-device-type'] as string) || 'unknown',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || '',
      },
    );
    return reply.send({ success: true, data: result });
  });

  app.post('/password/set', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = setPasswordSchema.parse(request.body);
    const sessionId = request.authSessionId;
    if (!sessionId) {
      throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
    }
    await authService.setPassword(request.user.userId, sessionId, body.password);
    return reply.send({ success: true });
  });

  // Reset request = just the normal OTP send; reset proves ownership again
  app.post('/password/reset-request', otpRateLimit, async (request, reply) => {
    const body = sendOtpSchema.parse(request.body);
    const result = await authService.sendOtp(body.phone);
    return reply.send({ success: true, data: result });
  });

  app.post('/password/reset', otpRateLimit, async (request, reply) => {
    const body = resetPasswordSchema.parse(request.body);
    await authService.resetPassword(body.phone, body.code, body.newPassword);
    return reply.send({ success: true, data: { message: 'Password reset. All sessions logged out.' } });
  });

  // ── Country picker (public — used before signup) ───────────────────────

  app.get('/countries', async (_request, reply) => {
    // Public picker: list ALL Caribbean markets, live ones first. Live (isActive) →
    // full signup; others show "coming soon"/waitlist. Only picker-safe fields are
    // exposed (no tiers/checklists/cash-rules — OWASP API3). Dial codes are static
    // reference data kept here rather than as a DB column (no migration).
    const DIAL_CODES: Record<string, string> = {
      GY: '+592', TT: '+1868', JM: '+1876', BB: '+1246', BS: '+1242', SR: '+597',
      BZ: '+501', GD: '+1473', LC: '+1758', AG: '+1268', VC: '+1784', KN: '+1869', DM: '+1767',
    };
    const countries = await app.prisma.countryConfig.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: { code: true, name: true, currencyCode: true, currencySymbol: true, isActive: true },
    });
    return reply.send({
      success: true,
      data: countries.map((c) => ({ ...c, dialCode: DIAL_CODES[c.code] ?? null })),
    });
  });

  /** Public price list — SaaS sells with the price on the door: partners see
   *  "14 days free, then X/week" BEFORE committing. Customers never pay, so
   *  nothing here concerns them. Weekly tiers only; checklists/cash-rules
   *  stay internal (OWASP API3). */
  app.get('/pricing', async (request, reply) => {
    const { country } = z.object({ country: z.string().length(2).default('GY') }).parse(request.query ?? {});
    const config = await app.prisma.countryConfig.findUnique({
      where: { code: country.toUpperCase() },
      select: { code: true, currencyCode: true, currencySymbol: true, subscriptionTiers: true, isActive: true },
    });
    if (!config) throw new AppError(404, 'COUNTRY_NOT_FOUND', 'No such market');
    const tiers = (config.subscriptionTiers ?? {}) as Record<string, number>;
    return reply.send({
      success: true,
      data: {
        countryCode: config.code,
        currencyCode: config.currencyCode,
        currencySymbol: config.currencySymbol,
        isActive: config.isActive,
        trialDays: TRIAL_DAYS,
        weekly: {
          mover: tiers['mover'] ?? null,
          smallVendor: tiers['smallVendor'] ?? null,
          largeVendor: tiers['largeVendor'] ?? null,
        },
      },
    });
  });
}
