/**
 * Shared pino options: structured logs with request correlation,
 * and secrets redacted before they can ever reach log output. server.ts and
 * the hardening test consume the same object, so the test proves production
 * behaviour, not a copy of it.
 */
export const loggerRedactConfig = {
  paths: [
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
