import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { AppError } from '../../utils/errors';
import { generateOtp, storeOtp, verifyOtp, checkOtpRateLimit } from '../../utils/otp';

interface DeviceInfo {
  deviceId: string;
  deviceType: string;
  ipAddress: string;
  userAgent: string;
}

export class AuthService {
  constructor(private app: FastifyInstance) {}

  async sendOtp(phone: string) {
    // Rate limiting
    const allowed = await checkOtpRateLimit(this.app.redis, phone);
    if (!allowed) {
      throw new AppError(429, 'RATE_LIMITED', 'Please wait before requesting another OTP');
    }

    const otp = process.env['NODE_ENV'] === 'development' ? '123456' : generateOtp();

    // Store in Redis with 5-min TTL
    await storeOtp(this.app.redis, phone, otp);

    // In development, log the OTP
    if (process.env['NODE_ENV'] === 'development') {
      this.app.log.info(`OTP for ${phone}: ${otp}`);
    }

    // TODO: Send via SMS provider (Twilio / GTT API)
    // await this.sendSms(phone, `Your Swift verification code is: ${otp}`);

    return { message: 'OTP sent successfully', expiresIn: 300 };
  }

  async verifyOtp(phone: string, code: string, deviceInfo: DeviceInfo) {
    // In development, accept fixed OTP and skip Redis check
    if (process.env['NODE_ENV'] === 'development') {
      if (code !== '123456') {
        throw new AppError(400, 'INVALID_OTP', 'Invalid or expired OTP');
      }
    } else {
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
      return { isNewUser: true, phone };
    }

    const tokens = await this.createSession(user.id, user.activeRole, deviceInfo);

    // Update last active
    await this.app.prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date(), isPhoneVerified: true },
    });

    return { isNewUser: false, user, tokens };
  }

  async register(data: { phone: string; firstName: string; lastName: string; email?: string }) {
    const existing = await this.app.prisma.user.findUnique({ where: { phone: data.phone } });
    if (existing) {
      throw new AppError(409, 'USER_EXISTS', 'User with this phone already exists');
    }

    if (data.email) {
      const emailExists = await this.app.prisma.user.findUnique({ where: { email: data.email } });
      if (emailExists) {
        throw new AppError(409, 'EMAIL_EXISTS', 'This email is already registered');
      }
    }

    const user = await this.app.prisma.user.create({
      data: {
        phone: data.phone,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
        isPhoneVerified: true,
        customer: { create: {} },
      },
      include: { customer: true },
    });

    const tokens = await this.createSession(user.id, user.activeRole, {
      deviceId: 'registration',
      deviceType: 'unknown',
      ipAddress: '',
      userAgent: '',
    });

    return { user, tokens };
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
    });
    const newRefreshToken = nanoid(64);

    await this.app.prisma.session.update({
      where: { id: session.id },
      data: {
        token: newAccessToken,
        refreshToken: newRefreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: 86400,
    };
  }

  async logout(token: string) {
    await this.app.prisma.session.deleteMany({ where: { token } });
  }

  async logoutAll(userId: string) {
    await this.app.prisma.session.deleteMany({ where: { userId } });
  }

  private async createSession(userId: string, role: string, deviceInfo: DeviceInfo) {
    const accessToken = this.app.jwt.sign({ userId, role });
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
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 86400, // 24 hours
    };
  }
}
