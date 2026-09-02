import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import bcrypt from 'bcryptjs';
import type { Prisma, SessionAuthMethod, UserRole, UserStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { countryFromPhone } from '../../utils/phone-country';
import { generateOtp, storeOtp, verifyOtp, checkOtpRateLimit } from '../../utils/otp';
import { checkOtpDailyBudget } from '../../utils/sms-budget';
import { CountryConfigService } from '../country/country-config.service';
import { getChannels } from '../../providers/notifications/channels';
import { LEGAL_VERSION, TERMS, PRIVACY } from '../legal/legal.routes';
import { publishLegalDocument, recordConsent } from '../legal/consent.service';
import {
  completeMoverSessionRevocation,
  emptyMoverSessionRevocationCleanup,
  retireMoverSessionAuthorityInTransaction,
  type MoverSessionRevocationCleanup,
} from '../mover-authority';
import { persistMoverRevocationOutboxInTransaction } from '../mover-revocation-outbox';
import { captureError, securityAuditFailuresCounter } from '../../plugins/observability';
import {
  hasPrivilegedSessionAssurance,
  requiresPrivilegedSessionAssurance,
} from './session-assurance';
import {
  disconnectSessionSockets as disconnectAuthorizationSessionSockets,
  disconnectUserSockets as disconnectAuthorizationUserSockets,
} from '../../utils/socket-revocation';
import { isDevelopment, isProduction } from '../../utils/runtime-mode';

interface DeviceInfo {
  deviceId: string;
  deviceType: string;
  ipAddress: string;
  userAgent: string;
}

/** Public signup roles (locked model) mapped to internal UserRole values. */
export type SignupRole = 'CUSTOMER' | 'MOVER' | 'VENDOR';

const OTP_VERIFIED_PREFIX = 'otp_verified:';
const OTP_VERIFIED_TTL = 600; // 10 min window between verify-otp and register

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
/** Fields that must never leave the API on a user object. A deny-list (not a
 *  select) so the response keeps its shape — the app reads roles and the
 *  rider/driver/vendorOwner includes to route the account to its surface. */
const SENSITIVE_USER_FIELDS = [
  'passwordHash',
  'failedLoginAttempts',
  'lockedUntil',
  'lastKnownLat',
  'lastKnownLng',
] as const;

export function sanitizeUser<T extends Record<string, unknown>>(
  user: T,
): Omit<T, (typeof SENSITIVE_USER_FIELDS)[number]> {
  const copy: Record<string, unknown> = { ...user };
  for (const field of SENSITIVE_USER_FIELDS) delete copy[field];
  return copy as Omit<T, (typeof SENSITIVE_USER_FIELDS)[number]>;
}

export class AuthService {
  private countryConfig: CountryConfigService;
  private channels: ReturnType<typeof getChannels>;

  // channels is injectable so tests can drive the SMS-failure path.
  constructor(private app: FastifyInstance, channels?: ReturnType<typeof getChannels>) {
    this.countryConfig = new CountryConfigService(app.prisma);
    this.channels = channels ?? getChannels();
  }

  async sendOtp(phone: string) {
    // Rate limiting
    const allowed = await checkOtpRateLimit(this.app.redis, phone);
    if (!allowed) {
      throw new AppError(429, 'RATE_LIMITED', 'Please wait before requesting another OTP');
    }

    // Trial-integrity §5: the hourly cap (config, not code — a legit user
    // with flaky SMS retries 3–4×; a flooder burns through 5). The cooldown
    // is honest about when to try again.
    const settings = await this.app.prisma.integritySettings.findUnique({ where: { id: 'platform' } }).catch(() => null);
    const hourlyMax = settings?.maxOtpPerPhonePerHour ?? 5;
    const hourKey = `otp_hr:${phone}`;
    const hourCount = await this.app.redis.incr(hourKey);
    if (hourCount === 1) await this.app.redis.expire(hourKey, 3600);
    if (hourCount > hourlyMax) {
      const ttl = await this.app.redis.ttl(hourKey);
      const minutes = Math.max(1, Math.ceil((ttl > 0 ? ttl : 3600) / 60));
      throw new AppError(429, 'RATE_LIMITED', `Too many codes requested for this number. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }

    // Hard daily cost ceilings (per-phone + global circuit breaker) so an abuse
    // spike can't run up the SMS bill. Checked before any SMS is generated/sent.
    const budget = await checkOtpDailyBudget(this.app.redis, phone);
    if (!budget.allowed) {
      if (budget.reason === 'global_daily') {
        this.app.log.error('[sms-budget] global daily OTP cap reached — refusing further sends until reset');
      }
      throw new AppError(429, 'RATE_LIMITED', 'Too many verification requests right now. Please try again later.');
    }

    const otp = generateOtp();

    // Store in Redis with 5-min TTL
    await storeOtp(this.app.redis, phone, otp);

    if (isDevelopment()) {
      this.app.log.info(`[DEV] OTP for ${phone}: ${otp}`);
    }

    // Delivery rides the swappable SMS channel (Twilio-class adapter later).
    // Do NOT claim success when the send fails — the user would wait forever
    // for a code that never left the building. send-otp runs before any
    // account exists, so a real error can't leak whether a number is
    // registered; failing loudly is honest and lets the user retry. The dev
    // adapter never throws, so local flows are unaffected.
    try {
      await this.channels.sms.sendSms(phone, `Your Swift verification code is: ${otp}`);
    } catch (err) {
      this.app.log.error({ err, phone: phone.slice(0, 5) + '***' }, '[otp] SMS send failed');
      throw new AppError(502, 'SMS_SEND_FAILED', "We couldn't send your code right now. Please try again in a moment.");
    }

    return { message: 'OTP sent successfully', expiresIn: 300 };
  }

  async verifyOtp(phone: string, code: string, deviceInfo: DeviceInfo) {
    // Dev-only master code: there is no SMS locally. Requires an EXPLICIT opt-in
    // (DEV_OTP_BYPASS=1) AND non-production NODE_ENV, so it is inert in tests, CI,
    // staging and prod — only active when a developer deliberately enables it locally.
    const devBypass =
      !isProduction() &&
      process.env['DEV_OTP_BYPASS'] === '1' &&
      code === '000000';
    if (!devBypass) {
      const result = await verifyOtp(this.app.redis, phone, code);
      if (!result.valid) {
        throw new AppError(400, 'INVALID_OTP', result.reason || 'Invalid or expired OTP');
      }
    }

    // Find existing user
    const user = await this.app.prisma.user.findUnique({
      where: { phone },
      include: { customer: true, rider: true, driver: true, vendorOwner: true, admin: true },
    });

    if (!user) {
      // Phone ownership proven — open a short registration window.
      // register() requires this flag, so signups are OTP-mandatory (L1).
      await this.app.redis.set(`${OTP_VERIFIED_PREFIX}${phone}`, '1', 'EX', OTP_VERIFIED_TTL);
      return { isNewUser: true, phone };
    }

    const tokens = await this.createSession(user.id, user.activeRole, deviceInfo, 'OTP');

    // Update last active
    await this.app.prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date(), isPhoneVerified: true },
    });

    return { isNewUser: false, user: sanitizeUser(user), tokens };
  }

  /** Once per process: anchor the served terms/privacy texts at LEGAL_VERSION
   *  so signup consent rows always have a published document to bind to. */
  private signupDocsPublished: Promise<void> | null = null;
  private ensureSignupDocsPublished(): Promise<void> {
    this.signupDocsPublished ??= (async () => {
      await publishLegalDocument(this.app.prisma, {
        documentType: 'terms_of_service', version: LEGAL_VERSION, renderedText: TERMS,
      });
      await publishLegalDocument(this.app.prisma, {
        documentType: 'privacy_policy', version: LEGAL_VERSION, renderedText: PRIVACY,
      });
    })().catch((err) => {
      this.signupDocsPublished = null; // next signup retries rather than caching failure
      throw err;
    });
    return this.signupDocsPublished;
  }

  async register(data: {
    phone: string;
    firstName: string;
    lastName: string;
    email?: string;
    role?: SignupRole;
    countryCode?: string;
    acceptTerms?: boolean;
    /** Request metadata for silent identity capture — never client-trusted
     *  for anything but SOFT signals (households/CGNAT never punish alone). */
    deviceId?: string | null;
    ipAddress?: string | null;
  }) {
    const existing = await this.app.prisma.user.findUnique({ where: { phone: data.phone } });
    if (existing) {
      throw new AppError(409, 'USER_EXISTS', 'User with this phone already exists');
    }

    // OTP at signup is MANDATORY (trust level L1) — verify-otp for this phone
    // must have succeeded within the registration window.
    const otpVerified = await this.app.redis.get(`${OTP_VERIFIED_PREFIX}${data.phone}`);
    if (!otpVerified) {
      throw new AppError(403, 'OTP_REQUIRED', 'Verify your phone with an OTP before registering');
    }

    if (data.email) {
      const emailExists = await this.app.prisma.user.findUnique({ where: { email: data.email } });
      if (emailExists) {
        throw new AppError(409, 'EMAIL_EXISTS', 'This email is already registered');
      }
    }

    // The PHONE decides the market: pricing, currency, and checklists follow
    // the dial prefix, never a client-picked field (which is only a fallback
    // for prefixes we don't know). Inactive countries stay waitlist-only.
    const countryCode = countryFromPhone(data.phone) ?? data.countryCode ?? 'GY';
    const activeCountries = await this.countryConfig.getActiveCountries();
    if (!activeCountries.some((c) => c.code === countryCode)) {
      throw new AppError(400, 'COUNTRY_NOT_ACTIVE', 'Swift is not live in this country yet — join the waitlist');
    }

    const signupRole: SignupRole = data.role ?? 'CUSTOMER';
    // Everyone can order (multi-role); VENDOR maps to the internal VENDOR_OWNER.
    const roleSetup: Record<SignupRole, { roles: UserRole[]; activeRole: UserRole }> = {
      CUSTOMER: { roles: ['CUSTOMER'], activeRole: 'CUSTOMER' },
      MOVER: { roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER' },
      VENDOR: { roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER' },
    };
    const { roles, activeRole } = roleSetup[signupRole];

    // [DCR-1 NR1-02] Consent is captured in the SAME transaction that creates
    // the account — an account without its ledger rows is the un-fixable gap
    // the consent gate exists to prevent. The served legal texts are published
    // (hash-anchored, idempotent) before the transaction so the rows always
    // anchor to the exact words /legal/terms and /legal/privacy render.
    const consented = data.acceptTerms === true;
    if (consented) await this.ensureSignupDocsPublished();
    const user = await this.app.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone: data.phone,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          roles,
          activeRole,
          countryCode,
          isPhoneVerified: true,
          // SWIFT-AUD-D9-03: consent is recorded with the version it covered —
          // demonstrable under DPA 2023, not just a client-side checkbox.
          ...(consented && { acceptedTermsAt: new Date(), tosVersion: LEGAL_VERSION }),
          customer: { create: {} },
          ...(signupRole === 'VENDOR' && { vendorOwner: { create: {} } }),
        },
        include: { customer: true, vendorOwner: true },
      });
      if (consented) {
        for (const documentType of ['privacy_policy', 'terms_of_service'] as const) {
          await recordConsent(tx, {
            subjectType: 'customer',
            subjectId: created.id,
            documentType,
            version: LEGAL_VERSION,
            action: 'granted',
            surface: 'mobile',
            ip: data.ipAddress,
            evidence: { control: 'accept_terms_checkbox', path: 'auth/register', role: signupRole },
          });
        }
      }
      return created;
    });

    // Single-use registration window
    await this.app.redis.del(`${OTP_VERIFIED_PREFIX}${data.phone}`);

    // Identity-integrity capture (trial-integrity §2.1) — silent, fire-and-
    // forget: PHONE (STRONG) + EMAIL (SOFT) + the §5 SignupAttempt velocity
    // row. Zero UX change; a capture failure never touches signup.
    {
      const { captureSignup } = await import('../integrity/capture-hooks');
      captureSignup(this.app.prisma, {
        userId: user.id,
        role: signupRole,
        phone: data.phone,
        email: data.email ?? null,
        deviceId: data.deviceId ?? null,
        ip: data.ipAddress ?? null,
      });
    }

    const tokens = await this.createSession(
      user.id,
      user.activeRole,
      {
        deviceId: 'registration',
        deviceType: 'unknown',
        ipAddress: '',
        userAgent: '',
      },
      'OTP',
    );

    // Role-specific onboarding stub — verification itself comes later.
    const onboarding = await this.buildOnboarding(signupRole, countryCode);

    return { user: sanitizeUser(user), tokens, onboarding };
  }

  /** What the client should do next after signup (stub until verification). */
  private async buildOnboarding(role: SignupRole, countryCode: string) {
    if (role === 'MOVER') {
      return {
        next: 'VERIFICATION',
        requiredDocuments: await this.countryConfig.getDocumentChecklist(countryCode, 'MOVER'),
      };
    }
    if (role === 'VENDOR') {
      return { next: 'VENDOR_SETUP', requiredDocuments: [] as string[] };
    }
    return { next: 'BROWSE', requiredDocuments: [] as string[] };
  }

  // -------------------------------------------------------------------------
  // Email + password (secondary to phone OTP)
  // -------------------------------------------------------------------------

  async setPassword(userId: string, sessionId: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 12);
    await this.app.prisma.$transaction(async (tx) => {
      // Authenticate-time proof is not enough for a security mutation: a
      // password reset, ban, or logout may revoke this session while bcrypt is
      // running. Serialize with those paths (User -> Session), then prove the
      // exact request generation still exists before changing the credential.
      const users = await tx.$queryRaw<Array<{ status: UserStatus }>>`
        SELECT "status"
        FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE
      `;
      const user = users[0];
      if (!user) {
        throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
      }

      const sessions = await tx.$queryRaw<Array<{ id: string; expiresAt: Date }>>`
        SELECT "id", "expiresAt"
        FROM "sessions"
        WHERE "id" = ${sessionId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      const session = sessions[0];
      if (!session || session.expiresAt <= new Date()) {
        throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
      }
      if (
        user.status === 'SUSPENDED'
        || user.status === 'BANNED'
        || user.status === 'DEACTIVATED'
      ) {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
      }

      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
      });
    });
  }

  async loginWithPassword(
    identifier: { phone?: string; email?: string },
    password: string,
    deviceInfo: DeviceInfo,
  ) {
    const user = identifier.phone
      ? await this.app.prisma.user.findUnique({ where: { phone: identifier.phone } })
      : await this.app.prisma.user.findUnique({ where: { email: identifier.email! } });

    // One generic failure for unknown user / no password / wrong password —
    // no account enumeration through this endpoint.
    const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'Invalid phone/email or password');
    if (!user || !user.passwordHash) throw invalid;

    if (
      user.lockedUntil
      && user.lockedUntil > new Date()
      && !requiresPrivilegedSessionAssurance(user.activeRole, user.roles)
    ) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${minutesLeft} min`);
    }

    const matches = await bcrypt.compare(password, user.passwordHash);

    // Password hashing stays outside the lock so one expensive comparison does
    // not block every security mutation for this user. Once it finishes, both
    // outcomes take the same User lock and revalidate the exact hash compared.
    // This makes failed-attempt accounting linearizable and prevents an old
    // failed comparison from re-locking a credential generation that reset has
    // already replaced.
    const login = await this.app.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        passwordHash: string | null;
        failedLoginAttempts: number;
        lockedUntil: Date | null;
        roles: UserRole[];
        activeRole: UserRole;
        status: UserStatus;
      }>>`
        SELECT "passwordHash", "failedLoginAttempts", "lockedUntil",
               "roles", "activeRole", "status"
        FROM "users"
        WHERE "id" = ${user.id}
        FOR UPDATE
      `;
      const locked = rows[0];
      if (!locked || locked.passwordHash !== user.passwordHash) {
        return { kind: 'invalid' as const };
      }

      // Password is not an approved privileged proof. This check deliberately
      // precedes lockout, status, and password-result branching and returns the
      // same generic failure as an unknown account or bad credential. A caller
      // therefore cannot use this endpoint to confirm that a privileged
      // password is valid, while a concurrent promotion observed under this
      // User lock still cannot mint a password-authenticated session.
      if (requiresPrivilegedSessionAssurance(locked.activeRole, locked.roles)) {
        return { kind: 'invalid' as const };
      }

      const now = new Date();
      if (locked.lockedUntil && locked.lockedUntil > now) {
        const minutesLeft = Math.ceil((locked.lockedUntil.getTime() - now.getTime()) / 60_000);
        throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${minutesLeft} min`);
      }

      if (!matches) {
        const failed = locked.failedLoginAttempts + 1;
        const shouldLock = failed >= MAX_FAILED_LOGINS;
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: shouldLock ? 0 : failed,
            ...(shouldLock && {
              lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60_000),
            }),
          },
        });
        return { kind: 'invalid' as const };
      }

      if (
        locked.status === 'SUSPENDED'
        || locked.status === 'BANNED'
        || locked.status === 'DEACTIVATED'
      ) {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
      }

      const accessToken = this.app.jwt.sign({
        userId: user.id,
        role: locked.activeRole,
        jti: nanoid(8),
      });
      const refreshToken = nanoid(64);
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastActiveAt: now },
      });
      await tx.session.create({
        data: {
          userId: user.id,
          token: accessToken,
          refreshToken,
          authMethod: 'PASSWORD',
          deviceId: deviceInfo.deviceId,
          deviceType: deviceInfo.deviceType,
          ipAddress: deviceInfo.ipAddress,
          userAgent: deviceInfo.userAgent,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return {
        kind: 'success' as const,
        activeRole: locked.activeRole,
        status: locked.status,
        tokens: { accessToken, refreshToken, expiresIn: 900 },
      };
    });
    if (login.kind === 'invalid') throw invalid;
    return {
      user: sanitizeUser({ ...user, activeRole: login.activeRole, status: login.status }),
      tokens: login.tokens,
    };
  }

  /** Reset = prove phone ownership again via OTP, then rotate everything. */
  async resetPassword(phone: string, code: string, newPassword: string) {
    const result = await verifyOtp(this.app.redis, phone, code);
    if (!result.valid) {
      throw new AppError(400, 'INVALID_OTP', result.reason || 'Invalid or expired OTP');
    }

    const candidate = await this.app.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (!candidate) {
      // Do NOT reveal account existence on password reset — return the same
      // error a wrong OTP would, so an attacker (who somehow has a valid code)
      // can't enumerate which phone numbers have accounts.
      throw new AppError(400, 'INVALID_OTP', 'Invalid or expired OTP');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    // Keep the idempotency key stable for the lifetime of this transaction
    // invocation. A password reset is one global security generation, not a
    // collection of independently committed writes.
    const revocationId = nanoid(24);
    const reset = await this.app.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${candidate.id} AND "phone" = ${phone}
        FOR UPDATE
      `;
      const user = users[0];
      if (!user) return null;

      // Deliberately write the credential first: any later authority, outbox,
      // session, or device-token failure aborts this transaction and rolls the
      // new hash back with it. There is no window where the password changed
      // while a stolen session remained valid.
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
      });
      const cleanup = await this.revokeAllLockedSessionsInTransaction(
        tx,
        user.id,
        `password-reset:${user.id}:${revocationId}`,
      );
      return { userId: user.id, cleanup };
    });

    // The phone changed or account disappeared after OTP verification. Preserve
    // the same non-enumerating public error as the initial lookup.
    if (!reset) {
      throw new AppError(400, 'INVALID_OTP', 'Invalid or expired OTP');
    }

    // PostgreSQL already committed the complete security decision. Realtime
    // eviction and low-latency outbox processing are best-effort accelerators;
    // the recurring worker remains the durable retry path.
    this.disconnectUserSockets(reset.userId);
    await completeMoverSessionRevocation(this.app, reset.cleanup)
      .catch((error) => this.app.log.error(
        { err: error, userId: reset.userId },
        'post-password-reset mover cleanup failed',
      ));
  }

  async refreshTokens(refreshToken: string) {
    // Resolve without a lock only to discover the canonical User -> Session
    // lock keys. Every security decision is repeated after both rows are
    // locked, so refresh, theft-replay, authenticated logout, and
    // refresh-credential logout have one serialization order.
    const candidate = await this.findSessionByRefreshCredential(refreshToken);
    if (!candidate) {
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired refresh token');
    }

    const outcome = await this.app.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{
        id: string;
        status: string;
        activeRole: UserRole;
        roles: UserRole[];
      }>>`
        SELECT "id", "status"::text AS "status",
               "activeRole"::text AS "activeRole", "roles"
        FROM "users"
        WHERE "id" = ${candidate.userId}
        FOR UPDATE
      `;
      const user = users[0];
      if (!user) return { kind: 'invalid' as const };

      const sessions = await tx.$queryRaw<Array<{
        id: string;
        userId: string;
        token: string;
        refreshToken: string;
        previousRefreshToken: string | null;
        rotatedAt: Date | null;
        expiresAt: Date;
        deviceId: string;
        deviceType: string;
        authMethod: SessionAuthMethod;
      }>>`
        SELECT "id", "userId", "token", "refreshToken", "previousRefreshToken",
               "rotatedAt", "expiresAt", "deviceId", "deviceType",
               "authMethod"::text AS "authMethod"
        FROM "sessions"
        WHERE "id" = ${candidate.id} AND "userId" = ${candidate.userId}
        FOR UPDATE
      `;
      const session = sessions[0];
      if (!session) return { kind: 'invalid' as const };

      if (session.expiresAt < new Date()) {
        return { kind: 'invalid' as const };
      }
      // SEC: a suspended/banned/deactivated account cannot rotate new tokens.
      if (['SUSPENDED', 'BANNED', 'DEACTIVATED'].includes(user.status)) {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
      }
      if (
        requiresPrivilegedSessionAssurance(user.activeRole, user.roles)
        && !hasPrivilegedSessionAssurance(session.authMethod)
      ) {
        const cleanup = await this.revokeLockedSession(tx, session.id, session.userId);
        return {
          kind: 'insufficient_assurance' as const,
          sessionId: session.id,
          userId: session.userId,
          cleanup,
        };
      }

      if (session.refreshToken !== refreshToken) {
        if (session.previousRefreshToken !== refreshToken) {
          return { kind: 'invalid' as const };
        }

        // A legitimate double-fire immediately after rotation receives the
        // already-current pair. Outside the grace period, the same credential
        // is theft evidence and revokes the locked session atomically.
        const graceMs = Number(process.env['REFRESH_REUSE_GRACE_MS'] ?? 10_000);
        const age = session.rotatedAt ? Date.now() - session.rotatedAt.getTime() : Infinity;
        if (age <= graceMs) {
          return {
            kind: 'success' as const,
            tokens: {
              accessToken: session.token,
              refreshToken: session.refreshToken,
              expiresIn: 900,
            },
          };
        }

        const cleanup = await this.revokeLockedSession(tx, session.id, session.userId);
        return {
          kind: 'reuse' as const,
          userId: session.userId,
          sessionId: session.id,
          deviceId: session.deviceId,
          deviceType: session.deviceType,
          cleanup,
        };
      }

      const newAccessToken = this.app.jwt.sign({
        userId: user.id,
        role: user.activeRole,
        jti: nanoid(8),
      });
      const newRefreshToken = nanoid(64);
      await tx.session.update({
        where: { id: session.id },
        data: {
          token: newAccessToken,
          refreshToken: newRefreshToken,
          previousRefreshToken: refreshToken,
          rotatedAt: new Date(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return {
        kind: 'success' as const,
        tokens: { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: 900 },
      };
    });

    if (outcome.kind === 'success') return outcome.tokens;
    if (outcome.kind === 'insufficient_assurance') {
      this.disconnectSessionSockets(outcome.sessionId);
      await completeMoverSessionRevocation(this.app, outcome.cleanup)
        .catch((error) => this.app.log.error(
          { err: error, userId: outcome.userId, sessionId: outcome.sessionId },
          'post-insufficient-assurance mover cleanup failed',
        ));
      this.app.log.warn(
        { userId: outcome.userId, sessionId: outcome.sessionId },
        '[auth] privileged session lacked approved assurance and was revoked',
      );
    }
    if (outcome.kind === 'reuse') {
      this.disconnectSessionSockets(outcome.sessionId);
      await completeMoverSessionRevocation(this.app, outcome.cleanup)
        .catch((error) => this.app.log.error({ err: error, sessionId: outcome.sessionId }, 'post-revocation mover cleanup failed'));
      await this.app.prisma.auditLog.create({
        data: {
          userId: outcome.userId,
          action: 'REFRESH_TOKEN_REUSE',
          entity: 'Session',
          entityId: outcome.sessionId,
          changes: { deviceId: outcome.deviceId, deviceType: outcome.deviceType },
        },
      }).catch((error) => {
        // The security decision is already committed. Never turn the promised
        // uniform 401 into a 500 or tempt a caller to retry a credential that
        // was correctly revoked. Emit independent operational evidence instead.
        securityAuditFailuresCounter.inc({ action: 'REFRESH_TOKEN_REUSE' });
        captureError(error, {
          action: 'REFRESH_TOKEN_REUSE',
          userId: outcome.userId,
          sessionId: outcome.sessionId,
        });
        this.app.log.error(
          { err: error, userId: outcome.userId, sessionId: outcome.sessionId },
          '[auth] refresh-token reuse audit persistence failed after revocation',
        );
      });
      this.app.log.warn(
        { userId: outcome.userId, sessionId: outcome.sessionId },
        '[auth] rotated refresh token replayed — session revoked',
      );
    }
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired refresh token');
  }

  private findSessionByRefreshCredential(refreshToken: string) {
    return this.app.prisma.session.findFirst({
      where: {
        OR: [{ refreshToken }, { previousRefreshToken: refreshToken }],
      },
      select: { id: true, userId: true },
    });
  }

  private async revokeLockedSession(
    tx: Prisma.TransactionClient,
    sessionId: string,
    userId: string,
    pushToken?: string,
  ): Promise<MoverSessionRevocationCleanup> {
    const cleanup = await retireMoverSessionAuthorityInTransaction(tx, userId, sessionId);
    const outboxId = await persistMoverRevocationOutboxInTransaction(tx, {
      dedupeKey: `session:${sessionId}`,
      userId,
      cleanup,
    });
    if (pushToken) {
      await tx.deviceToken.updateMany({
        where: { token: pushToken, userId },
        data: { isActive: false },
      });
    }
    await tx.session.delete({ where: { id: sessionId } });
    return { ...cleanup, outboxId };
  }

  /** Revoke one authenticated device generation as a single authority change.
   *  The User lock serializes this with mover role/status transitions; the
   *  exact Session is then locked before any dependent ownership is cleared.
   *  Checking that locked session before touching the push token also makes
   *  duplicate logout calls harmless, while the userId predicate prevents an old account from
   *  deactivating a token that has since been reassigned to another account. */
  private async revokeSession(
    sessionId: string,
    userId: string,
    pushToken?: string,
  ): Promise<MoverSessionRevocationCleanup | null> {
    return this.app.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE
      `;
      if (!users[0]) return null;

      const sessions = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "sessions"
        WHERE "id" = ${sessionId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      if (!sessions[0]) return null;

      return this.revokeLockedSession(tx, sessionId, userId, pushToken);
    });
  }

  async logout(sessionId: string, userId: string, pushToken?: string) {
    const cleanup = await this.revokeSession(sessionId, userId, pushToken);
    if (cleanup) {
      this.disconnectSessionSockets(sessionId);
      await completeMoverSessionRevocation(this.app, cleanup)
        .catch((error) => this.app.log.error({ err: error, sessionId }, 'post-logout mover cleanup failed'));
    }
  }

  /** Revoke using a captured refresh credential after local state is already
   * gone. The pre-read discovers lock keys only; the locked row must still
   * match either the current or immediately-previous credential. Returning a
   * boolean is service-internal — the public route deliberately always emits
   * the same success response so it cannot be used as a token oracle. */
  async logoutByRefreshToken(refreshToken: string, pushToken?: string): Promise<boolean> {
    const candidate = await this.findSessionByRefreshCredential(refreshToken);
    if (!candidate) return false;

    const revokedSessionId = await this.app.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${candidate.userId}
        FOR UPDATE
      `;
      if (!users[0]) return null;

      const sessions = await tx.$queryRaw<Array<{
        id: string;
        refreshToken: string;
        previousRefreshToken: string | null;
      }>>`
        SELECT "id", "refreshToken", "previousRefreshToken"
        FROM "sessions"
        WHERE "id" = ${candidate.id} AND "userId" = ${candidate.userId}
        FOR UPDATE
      `;
      const session = sessions[0];
      if (
        !session
        || (session.refreshToken !== refreshToken && session.previousRefreshToken !== refreshToken)
      ) {
        return null;
      }

      const cleanup = await this.revokeLockedSession(tx, session.id, candidate.userId, pushToken);
      return { sessionId: session.id, cleanup };
    });

    if (revokedSessionId) {
      this.disconnectSessionSockets(revokedSessionId.sessionId);
      await completeMoverSessionRevocation(this.app, revokedSessionId.cleanup)
        .catch((error) => this.app.log.error({ err: error, sessionId: revokedSessionId.sessionId }, 'post-refresh-logout mover cleanup failed'));
    }
    return revokedSessionId !== null;
  }

  private disconnectSessionSockets(sessionId: string): void {
    try {
      disconnectAuthorizationSessionSockets(this.app.io, sessionId);
    } catch {
      /* sockets not wired here */
    }
  }

  private disconnectUserSockets(userId: string): void {
    try {
      disconnectAuthorizationUserSockets(this.app.io, userId);
    } catch {
      /* sockets not wired here */
    }
  }

  /** Global revocation core. The caller MUST hold the canonical User lock.
   * Keeping this transaction-only primitive shared by reset-password and
   * logout-all prevents either path from drifting into a partial commit. */
  private async revokeAllLockedSessionsInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    dedupeKey: string,
  ): Promise<MoverSessionRevocationCleanup> {
    const moverCleanup = await retireMoverSessionAuthorityInTransaction(tx, userId, null);
    const outboxId = await persistMoverRevocationOutboxInTransaction(tx, {
      dedupeKey,
      userId,
      cleanup: moverCleanup,
    });
    await tx.session.deleteMany({ where: { userId } });
    // Global revocation (logout-all, password reset) must silence a lost or
    // stolen device as well as its API session. A future sign-in explicitly
    // re-registers and reactivates the token on the current account.
    await tx.deviceToken.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });
    return { ...moverCleanup, outboxId };
  }

  async logoutAll(userId: string) {
    // One invocation can retire more than one auth generation. Keep a stable
    // key outside the transaction callback so any database retry writes the
    // same outbox event instead of inventing a duplicate.
    const revocationId = nanoid(24);
    const cleanup = await this.app.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${userId}
        FOR UPDATE
      `;
      if (!users[0]) return emptyMoverSessionRevocationCleanup();

      return this.revokeAllLockedSessionsInTransaction(
        tx,
        userId,
        `all-sessions:${userId}:${revocationId}`,
      );
    });
    // SWIFT-099: revoking every session must also drop live realtime
    // connections. The socket auth gate only runs at CONNECT, so an already-open
    // socket would keep receiving events after a log-out-everywhere / suspension.
    // Fire-and-forget: a disconnect failure must never fail the logout, and io
    // may be absent in a worker process.
    this.disconnectUserSockets(userId);
    await completeMoverSessionRevocation(this.app, cleanup)
      .catch((error) => this.app.log.error({ err: error, userId }, 'post-logout-all mover cleanup failed'));
  }

  private async createSession(
    userId: string,
    role: string,
    deviceInfo: DeviceInfo,
    authMethod: SessionAuthMethod,
  ) {
    const accessToken = this.app.jwt.sign({ userId, role, jti: nanoid(8) });
    const refreshToken = nanoid(64);

    await this.app.prisma.session.create({
      data: {
        userId,
        token: accessToken,
        refreshToken,
        authMethod,
        deviceId: deviceInfo.deviceId,
        deviceType: deviceInfo.deviceType,
        ipAddress: deviceInfo.ipAddress,
        userAgent: deviceInfo.userAgent,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutes — MUST match the JWT sign TTL (plugins/auth.ts) [SWIFT-107]
    };
  }
}
