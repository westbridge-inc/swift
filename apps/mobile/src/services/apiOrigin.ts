const PRODUCTION_API_ORIGIN = 'https://api.swift.gy';
const DEVELOPMENT_API_PORT = 3000;
const EXPO_HOST_PROTOCOLS = new Set(['exp', 'exps', 'http', 'https']);

export interface ResolveApiOriginOptions {
  explicitOrigin?: string | null;
  isDev: boolean;
  expoHostUri?: string | null;
  bundleScriptUrl?: string | null;
}

interface SourceCodeModuleLike {
  scriptURL?: unknown;
  getConstants?: () => unknown;
}

function invalidApiOrigin(reason: string): never {
  throw new Error(`Invalid API origin: ${reason}`);
}

function parseExplicitOrigin(value: string, isDev: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return invalidApiOrigin('EXPO_PUBLIC_API_URL must be an absolute HTTP(S) origin.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalidApiOrigin('EXPO_PUBLIC_API_URL must use HTTP or HTTPS.');
  }
  if (!isDev && parsed.protocol !== 'https:') {
    return invalidApiOrigin('non-development builds require HTTPS.');
  }
  if (!parsed.hostname) {
    return invalidApiOrigin('the hostname is missing.');
  }
  if (parsed.username || parsed.password) {
    return invalidApiOrigin('credentials are not allowed.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return invalidApiOrigin('paths, queries, and fragments are not allowed.');
  }

  return parsed.origin;
}

function parseExpoHostUri(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      'Development API origin is unavailable. Run the app with Expo CLI or set EXPO_PUBLIC_API_URL.',
    );
  }

  const schemeMatch = /^([a-z][a-z\d+.-]*):\/\//i.exec(trimmed);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (scheme && !EXPO_HOST_PROTOCOLS.has(scheme)) {
    throw new Error(
      'Development Expo host URI is invalid. Run the app with Expo CLI or set EXPO_PUBLIC_API_URL.',
    );
  }

  const authority = schemeMatch
    ? trimmed.slice(schemeMatch[0].length)
    : trimmed;

  try {
    return new URL(`http://${authority}`);
  } catch {
    throw new Error(
      'Development Expo host URI is invalid. Run the app with Expo CLI or set EXPO_PUBLIC_API_URL.',
    );
  }
}

function developmentOriginForHostname(hostname: string): string {
  const normalizedHostname = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  return new URL(`http://${normalizedHostname}:${DEVELOPMENT_API_PORT}`).origin;
}

function deriveFromExpoHostUri(expoHostUri: string): string {
  const parsed = parseExpoHostUri(expoHostUri);
  if (!parsed.hostname || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(
      'Development Expo host URI is invalid. Run the app with Expo CLI or set EXPO_PUBLIC_API_URL.',
    );
  }

  return developmentOriginForHostname(parsed.hostname);
}

function deriveFromBundleScriptUrl(bundleScriptUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(bundleScriptUrl.trim());
  } catch {
    throw new Error(
      'Development bundle URL is invalid. Load the app from Metro or set EXPO_PUBLIC_API_URL.',
    );
  }

  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error(
      'Development bundle URL is invalid. Load the app from Metro or set EXPO_PUBLIC_API_URL.',
    );
  }

  return developmentOriginForHostname(parsed.hostname);
}

function deriveDevelopmentOrigin(
  expoHostUri?: string | null,
  bundleScriptUrl?: string | null,
): string {
  let expoHostError: Error | undefined;
  if (expoHostUri?.trim()) {
    try {
      return deriveFromExpoHostUri(expoHostUri);
    } catch (error) {
      expoHostError = error instanceof Error
        ? error
        : new Error('Development Expo host URI is invalid.');
    }
  }
  if (bundleScriptUrl?.trim()) {
    return deriveFromBundleScriptUrl(bundleScriptUrl);
  }
  if (expoHostError) throw expoHostError;

  throw new Error(
    'Development API origin is unavailable. Load the app from Expo/Metro or set EXPO_PUBLIC_API_URL.',
  );
}

export function getReactNativeBundleScriptUrl(sourceCode: unknown): string | undefined {
  if ((typeof sourceCode !== 'object' || sourceCode === null)
    && typeof sourceCode !== 'function') {
    return undefined;
  }

  try {
    const source = sourceCode as SourceCodeModuleLike;
    if (typeof source.scriptURL === 'string' && source.scriptURL.trim()) {
      return source.scriptURL;
    }
    if (typeof source.getConstants !== 'function') return undefined;

    const constants = source.getConstants.call(sourceCode);
    if (typeof constants !== 'object' || constants === null) return undefined;
    const scriptURL = (constants as { scriptURL?: unknown }).scriptURL;
    return typeof scriptURL === 'string' && scriptURL.trim() ? scriptURL : undefined;
  } catch {
    return undefined;
  }
}

export function resolveApiOrigin({
  explicitOrigin,
  isDev,
  expoHostUri,
  bundleScriptUrl,
}: ResolveApiOriginOptions): string {
  if (explicitOrigin?.trim()) {
    return parseExplicitOrigin(explicitOrigin, isDev);
  }
  if (isDev) {
    return deriveDevelopmentOrigin(expoHostUri, bundleScriptUrl);
  }
  return PRODUCTION_API_ORIGIN;
}
