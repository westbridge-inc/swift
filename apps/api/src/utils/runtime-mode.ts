/**
 * [TA-S1-007 / F036-02] ONE typed runtime-mode parser.
 *
 * Every posture decision in the API — the boot guard, the provider factories
 * (payment, MMG, KYC, push, SMS/email, storage), the Socket.IO Redis adapter,
 * the OTP bypass, the salts — used to key on the exact string
 * `process.env.NODE_ENV === 'production'`. So an UNSET or MISSPELLED value
 * (`prod`, `Production`, an empty string, a deploy whose template defaulted to
 * `development`) was quietly treated as "not production": sandbox providers,
 * dev push that swallows every notification, plaintext KYC documents,
 * repository-known salts and a single-node realtime — while the process served
 * traffic. The highest-blast-radius silent absence in the sweep.
 *
 * The rule now: the mode is one of four exact words, parsed here and nowhere
 * else. Anything else is a FATAL misconfiguration — the boot guard refuses to
 * start, and any factory asked for the posture throws instead of guessing.
 * "Fail closed" means loud, never a quiet development posture.
 */
export const RUNTIME_MODES = ['production', 'development', 'test', 'loadtest'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export class RuntimeModeError extends Error {
  override readonly name = 'RuntimeModeError';
}

const MODE_SET: ReadonlySet<string> = new Set(RUNTIME_MODES);

/** Strict: the exact word, or a thrown RuntimeModeError. Never a default. */
export function parseRuntimeMode(raw: string | undefined): RuntimeMode {
  if (raw !== undefined && MODE_SET.has(raw)) return raw as RuntimeMode;
  throw new RuntimeModeError(
    `FATAL: NODE_ENV must be exactly one of ${RUNTIME_MODES.join(' | ')} — got ${raw === undefined ? '(unset)' : JSON.stringify(raw)}. ` +
    'An unknown or missing value is not "development"; it is a misconfiguration, and the process refuses to guess its posture.',
  );
}

/** The current process's mode. Throws on an unset or unknown NODE_ENV. */
export function runtimeMode(env: Record<string, string | undefined> = process.env): RuntimeMode {
  return parseRuntimeMode(env['NODE_ENV']);
}

/** Production posture: live providers required, dev escape hatches forbidden. */
export function isProduction(env: Record<string, string | undefined> = process.env): boolean {
  return runtimeMode(env) === 'production';
}

/** Local development only — NOT test, NOT loadtest: the one mode that may
 *  print an OTP to the log or echo an internal error message to a client. */
export function isDevelopment(env: Record<string, string | undefined> = process.env): boolean {
  return runtimeMode(env) === 'development';
}
