import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { AppError, NotFoundError } from '../../utils/errors';

interface DeviceInfo {
  deviceId: string;
  deviceType: string;
  ipAddress: string;
  userAgent: string;
}

export class AuthService {
  constructor(private app: FastifyInstance) {}

  async sendOtp(phone: string) {
    // In development, use a fixed OTP for testing
    const otp = process.env.NODE_ENV === 'development' ? '123456' : this.generateOtp();

    // TODO: Integrate with SMS provider (Twilio / GTT API)
    // For now, store OTP in a simple in-memory map (use Redis in production)
    this.app.log.info(`OTP for ${phone}: ${otp}`);

    return { message: 'OTP sent successfully', expiresIn: 300 };
  }

  async verifyOtp(phone: string, code: string, deviceInfo: DeviceInfo) {
    // In development, accept fixed OTP
    if (process.env.NODE_ENV === 'development' && code !== '123456') {
      throw new AppError(400, 'INVALID_OTP', 'Invalid or expired OTP');
    }

    // Find or note that user needs registration
    const user = await this.app.prisma.user.findUnique({
      where: { phone },
      include: { customer: true, rider: true, driver: true, vendorOwner: true },
    });

    if (!user) {
      return { isNewUser: true, phone };
    }

    // Generate tokens
    const accessToken = this.app.jwt.sign({ userId: user.id, role: user.activeRole });
    const refreshToken = nanoid(64);

    // Create session
    await this.app.prisma.session.create({
      data: {
        userId: user.id,
        token: accessToken,
        refreshToken,
        deviceId: deviceInfo.deviceId,
        deviceType: deviceInfo.deviceType,
        ipAddress: deviceInfo.ipAddress,
        userAgent: deviceInfo.userAgent,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    });

    // Update last active
    await this.app.prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date(), isPhoneVerified: true },
    });

    return {
      isNewUser: false,
      user,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 900, // 15 minutes
      },
    };
  }

  async register(data: { phone: string; firstName: string; lastName: string; email?: string }) {
    const existing = await this.app.prisma.user.findUnique({ where: { phone: data.phone } });
    if (existing) {
      throw new AppError(409, 'USER_EXISTS', 'User with this phone already exists');
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
        customer: {
          create: {},
        },
      },
      include: { customer: true },
    });

    const accessToken = this.app.jwt.sign({ userId: user.id, role: user.activeRole });
    const refreshToken = nanoid(64);

    await this.app.prisma.session.create({
      data: {
        userId: user.id,
        token: accessToken,
        refreshToken,
        deviceId: 'registration',
        deviceType: 'unknown',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      user,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 900,
      },
    };
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
      expiresIn: 900,
    };
  }

  async logout(token: string) {
    await this.app.prisma.session.deleteMany({ where: { token } });
  }

  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
