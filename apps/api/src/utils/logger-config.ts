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
  ],
  censor: '[redacted]',
};
