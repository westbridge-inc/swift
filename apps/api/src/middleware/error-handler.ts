import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../utils/errors';
import { ZodError } from 'zod';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
    // Zod validation errors
    if (error instanceof ZodError) {
      const details: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const path = issue.path.join('.');
        if (!details[path]) details[path] = [];
        details[path].push(issue.message);
      }
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request data',
          details,
        },
      });
    }

    // Custom app errors
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details && { details: error.details }),
        },
      });
    }

    // Fastify built-in errors (rate limit, etc.)
    if ('statusCode' in error && typeof error.statusCode === 'number') {
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.code || 'ERROR',
          message: error.message,
        },
      });
    }

    // Prisma errors
    if (error.constructor?.name === 'PrismaClientKnownRequestError') {
      const prismaError = error as { code: string; meta?: { target?: string[] } };
      if (prismaError.code === 'P2002') {
        return reply.status(409).send({
          success: false,
          error: {
            code: 'DUPLICATE',
            message: `A record with this ${prismaError.meta?.target?.join(', ') || 'field'} already exists`,
          },
        });
      }
      if (prismaError.code === 'P2025') {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Record not found' },
        });
      }
    }

    // Unknown errors
    app.log.error({ err: error, url: request.url, method: request.method }, 'Unhandled error');
    // SWIFT-AUD-D7-02: an error-rate SPIKE pages (dedup'd via the exact-count
    // trigger + a redis NX guard). Per-minute window counter; fire-and-caught
    // — accounting must never slow the error response, and minimal test
    // harnesses without redis just skip it.
    void (async () => {
      const redis = (app as { redis?: { incr(k: string): Promise<number>; expire(k: string, s: number): Promise<unknown>; set(k: string, v: string, ...a: unknown[]): Promise<unknown>; del(k: string): Promise<unknown> } }).redis;
      if (!redis) return;
      const windowKey = `err5xx:${Math.floor(Date.now() / 60_000)}`;
      const count = await redis.incr(windowKey);
      if (count === 1) await redis.expire(windowKey, 180);
      const threshold = Number(process.env['ERROR_RATE_ALERT_PER_MIN'] ?? '30');
      if (count !== threshold) return; // fire exactly once per window crossing
      const claimed = await redis.set('ops_page:error-spike', '1', 'EX', 900, 'NX');
      if (claimed !== 'OK') return;
      const { notifyAdmins, NotificationService } = await import('../modules/notification/notification.service');
      try {
        const paged = await notifyAdmins(app.prisma, new NotificationService(app.prisma, app.io), {
          // A 5xx SPIKE is an aggregate infra signal, single-flighted across
          // the whole API — not one tenant's event [NOC-A F45].
          tenantId: null,
          title: 'Server error spike',
          body: `${threshold}+ unhandled 500s in the last minute. Check Sentry / the API logs now.`,
          data: { kind: 'ops_error_spike', perMinute: threshold },
        });
        // [F-028-10] Zero recipients is not a delivered page. Holding the
        // 15-minute dedup claim after reaching NOBODY kept the outage dark
        // for the full window; release it so the next spike retries.
        if (paged === 0) await redis.del('ops_page:error-spike').catch(() => {});
      } catch {
        // Release the dedup claim so the next spike re-pages rather than staying
        // dark for the window on a transient notify failure.
        await redis.del('ops_page:error-spike').catch(() => {});
      }
    })().catch(() => {});
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env['NODE_ENV'] === 'development' ? error.message : 'An unexpected error occurred',
      },
    });
  });

  // 404 handler. Echo only the path — never the query string (reflected
  // attacker input has no business in responses) — and cap the length.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!.slice(0, 200);
    reply.status(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${path} not found`,
      },
    });
  });
}
