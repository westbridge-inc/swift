const ALLOWED_ORIGIN_PROTOCOLS = new Set(['http:', 'https:', 'tauri:']);

/**
 * One development allowlist for both Fastify and Socket.IO. Keeping the two
 * transports on the same policy prevents a web client from working over HTTP
 * while silently failing (or being configured more broadly) over realtime.
 */
export const DEFAULT_DEV_CORS_ORIGINS = [
  'http://localhost:3001',
  'http://localhost:3000',
  'http://127.0.0.1:3001',
  'http://localhost:3002',
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
] as const;

function normalizeOrigin(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate === '*' || candidate.toLowerCase() === 'null' || candidate.includes('*')) {
    throw new Error(`CORS_ORIGIN contains a forbidden origin: ${JSON.stringify(candidate)}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`CORS_ORIGIN contains an invalid URL origin: ${JSON.stringify(candidate)}`);
  }

  if (
    !ALLOWED_ORIGIN_PROTOCOLS.has(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error(`CORS_ORIGIN must contain only explicit HTTP(S) or Tauri origins: ${JSON.stringify(candidate)}`);
  }

  return parsed.protocol === 'tauri:'
    ? `${parsed.protocol}//${parsed.host}`
    : parsed.origin;
}

/**
 * Resolve an explicit, normalized allowlist. Production with no configured
 * browser origins remains fail-closed (`false`), and wildcard/null origins are
 * rejected because credentials are enabled on both HTTP and Socket.IO.
 */
export function resolveCorsOrigins(
  raw: string | undefined,
  nodeEnv: string | undefined,
  developmentOrigins: readonly string[] = DEFAULT_DEV_CORS_ORIGINS,
): string[] | false {
  if (raw === undefined) {
    return nodeEnv === 'development'
      ? [...new Set(developmentOrigins.map(normalizeOrigin))]
      : false;
  }

  const entries = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error('CORS_ORIGIN is set but contains no origins');
  }
  return [...new Set(entries.map(normalizeOrigin))];
}
