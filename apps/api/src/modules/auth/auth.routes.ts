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
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
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
}
