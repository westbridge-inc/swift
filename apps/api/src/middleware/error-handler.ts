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
