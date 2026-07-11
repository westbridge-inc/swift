import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { generateOtp, storeOtp, verifyOtp, checkOtpRateLimit } from '../../utils/otp';
import { checkOtpDailyBudget } from '../../utils/sms-budget';
import { CountryConfigService } from '../country/country-config.service';
import { getChannels } from '../../providers/notifications/channels';

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
  private channels = getChannels();

  constructor(private app: FastifyInstance) {
    this.countryConfig = new CountryConfigService(app.prisma);
  }

  async sendOtp(phone: string) {
    // Rate limiting
    const allowed = await checkOtpRateLimit(this.app.redis, phone);
    if (!allowed) {
      throw new AppError(429, 'RATE_LIMITED', 'Please wait before requesting another OTP');
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

    if (process.env['NODE_ENV'] === 'development') {
      this.app.log.info(`[DEV] OTP for ${phone}: ${otp}`);
    }

    // Delivery rides the swappable SMS channel (Twilio-class adapter later)
    await this.channels.sms
      .sendSms(phone, `Your Swift verification code is: ${otp}`)
      .catch(() => {});

    return { message: 'OTP sent successfully', expiresIn: 300 };
  }

  async verifyOtp(phone: string, code: string, deviceInfo: DeviceInfo) {
    // Dev-only master code: there is no SMS locally. Requires an EXPLICIT opt-in
    // (DEV_OTP_BYPASS=1) AND non-production NODE_ENV, so it is inert in tests, CI,
    // staging and prod — only active when a developer deliberately enables it locally.
    const devBypass =
      process.env['NODE_ENV'] !== 'production' &&
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

    const tokens = await this.createSession(user.id, user.activeRole, deviceInfo);

    // Update last active
    await this.app.prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date(), isPhoneVerified: true },
    });

    return { isNewUser: false, user: sanitizeUser(user), tokens };
  }

  async register(data: {
    phone: string;
    firstName: string;
    lastName: string;
    email?: string;
    role?: SignupRole;
    countryCode?: string;
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

    // Country comes from the live config; inactive countries are waitlist-only.
    const countryCode = data.countryCode ?? 'GY';
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

    const user = await this.app.prisma.user.create({
      data: {
        phone: data.phone,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        roles,
        activeRole,
        countryCode,
        isPhoneVerified: true,
        customer: { create: {} },
        ...(signupRole === 'VENDOR' && { vendorOwner: { create: {} } }),
      },
      include: { customer: true, vendorOwner: true },
    });

    // Single-use registration window
    await this.app.redis.del(`${OTP_VERIFIED_PREFIX}${data.phone}`);

    const tokens = await this.createSession(user.id, user.activeRole, {
      deviceId: 'registration',
      deviceType: 'unknown',
      ipAddress: '',
      userAgent: '',
    });

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

  async setPassword(userId: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 12);
    await this.app.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
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

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${minutesLeft} min`);
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      const failed = user.failedLoginAttempts + 1;
      await this.app.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: failed,
          ...(failed >= MAX_FAILED_LOGINS && {
            lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000),
            failedLoginAttempts: 0,
          }),
        },
      });
      throw invalid;
    }

    await this.app.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastActiveAt: new Date() },
    });

    const tokens = await this.createSession(user.id, user.activeRole, deviceInfo);
    return { user: sanitizeUser(user), tokens };
  }

  /** Reset = prove phone ownership again via OTP, then rotate everything. */
  async resetPassword(phone: string, code: string, newPassword: string) {
    const result = await verifyOtp(this.app.redis, phone, code);
    if (!result.valid) {
      throw new AppError(400, 'INVALID_OTP', result.reason || 'Invalid or expired OTP');
    }

    const user = await this.app.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'No account with this phone');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.app.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });

    // Kill every session — a reset must log out any stolen-token holder too
    await this.logoutAll(user.id);
  }

  async refreshTokens(refreshToken: string) {
    const session = await this.app.prisma.session.findUnique({
      where: { refreshToken },
      include: { user: true },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired refresh token');
    }

    const newAccessToken = this.app.jwt.sign({
      userId: session.user.id,
      role: session.user.activeRole,
      jti: nanoid(8),
    });
    const newRefreshToken = nanoid(64);

    await this.app.prisma.session.update({
      where: { id: session.id },
      data: {
        token: newAccessToken,
        refreshToken: newRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: 1800,
    };
  }

  async logout(token: string) {
    await this.app.prisma.session.deleteMany({ where: { token } });
  }

  async logoutAll(userId: string) {
    await this.app.prisma.session.deleteMany({ where: { userId } });
  }

  private async createSession(userId: string, role: string, deviceInfo: DeviceInfo) {
    const accessToken = this.app.jwt.sign({ userId, role, jti: nanoid(8) });
    const refreshToken = nanoid(64);

    await this.app.prisma.session.create({
      data: {
        userId,
        token: accessToken,
        refreshToken,
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
      expiresIn: 1800, // 30 minutes
    };
  }
}
