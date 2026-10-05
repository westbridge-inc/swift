import type { FastifyRequest } from 'fastify';

/** Raw targets can contain document grants and permanent path credentials.
 * Only server-registered route templates may identify a request in logs. */
export function requestLogContext(request: Pick<FastifyRequest, 'method' | 'routeOptions'>) {
  return { method: request.method, route: request.routeOptions?.url };
}

/** Error messages, stacks, causes and custom properties may carry complete
 * upstream requests. Keep only a bounded classification; reqId and the safe
 * route template supply correlation without retaining those credentials. */
export const loggerSerializers = {
  req(request: FastifyRequest) {
    return { ...requestLogContext(request), id: request.id };
  },
  err(error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    return { type: 'Error', message: '[redacted]', stack: '[redacted]', ...(typeof code === 'string' && /^(?:P\d{4}|FST_ERR_[A-Z_]+|E[A-Z]{2,20})$/.test(code) ? { code } : {}) };
  },
};

/**
 * Shared pino options: structured logs with request correlation,
 * and secrets redacted before they can ever reach log output. server.ts and
 * the hardening test consume the same object, so the test proves production
 * behaviour, not a copy of it.
 */
export const loggerRedactConfig = {
  paths: [
    // Authentication-store failure logs include a raw target outside `req`.
    'url',
    'req.headers.authorization',
    'req.headers.cookie',
    '*.password',
    '*.passwordHash',
    '*.refreshToken',
    '*.accessToken',
    '*.token',
    '*.cardNumber',
    '*.cvc',
    // Launch-readiness §1.6 / CLAUDE.md rule 4: OTPs, ride/pickup codes and
    // MMG credentials never reach a log line, even via logged payloads.
    '*.otp',
    '*.code',
    '*.pin',
    '*.ridePin',
    '*.pickupCode',
    '*.mmgPassword',
    '*.mkey',
    '*.msecret',
    // [PT-1 · C9] A card provider's vault token is a charge credential: never
    // in a log line, top level or nested.
    'vaultToken', '*.vaultToken',
    'req.body.code',
    'req.body.otp',
    // [DOC-1 §0.5] Raw extracted document PII and the signed URLs of PERSONAL
    // images never appear in a log line, at any level. pino's `*.key` matches
    // ONLY a nested key, so each path is listed bare (top level) and nested.
    'documentNumber', '*.documentNumber',
    'extracted', '*.extracted',
    'dateOfBirth', '*.dateOfBirth',
    'dob', '*.dob',
    'idDocumentUrl', '*.idDocumentUrl',
    'selfieUrl', '*.selfieUrl',
    'fileUrl', '*.fileUrl',
  ],
  censor: '[redacted]',
};
