import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from './auth.service';

const sendOtpSchema = z.object({
  phone: z.string().min(10).max(15),
});

const verifyOtpSchema = z.object({
  phone: z.string().min(10).max(15),
  code: z.string().length(6),
});

const registerSchema = z.object({
  phone: z.string().min(10).max(15),
  firstName: z.string().min(1).max(50),
  lastName: z.string().min(1).max(50),
  email: z.string().email().optional(),
  role: z.enum(['CUSTOMER', 'MOVER', 'VENDOR']).default('CUSTOMER'),
  countryCode: z.string().length(2).default('GY'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const passwordLoginSchema = z
  .object({
    phone: z.string().min(10).max(15).optional(),
    email: z.string().email().optional(),
    password: z.string().min(8).max(100),
  })
  .refine((d) => d.phone || d.email, { message: 'phone or email is required' });

const setPasswordSchema = z.object({
  password: z.string().min(8).max(100),
});

const resetPasswordSchema = z.object({
  phone: z.string().min(10).max(15),
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
    const result = await authService.register(body);
    return reply.status(201).send({ success: true, data: result });
  });

  app.post('/refresh', authRateLimit, async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const result = await authService.refreshTokens(body.refreshToken);
    return reply.send({ success: true, data: result });
  });

  app.post('/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    const token = request.headers.authorization?.replace('Bearer ', '') || '';
    await authService.logout(token);
    return reply.send({ success: true });
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
    await authService.setPassword(request.user.userId, body.password);
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
}
