/**
 * [L13 item 7] Crash reports carry diagnostics, never a person.
 *
 * Every event and breadcrumb the crash SDK would send passes through here on
 * the phone, before anything leaves it. Two layers:
 *  - STRUCTURE: whole fields that only ever describe a person are dropped
 *    (user, request body/headers/cookies/query, device name and install id,
 *    server name, navigation params, non-allowlisted extras), and breadcrumb
 *    kinds that echo what someone typed or touched are discarded outright.
 *  - TEXT: every remaining string is redacted for phone numbers, e-mail
 *    addresses, JWTs, bearer values, tokenised links and query strings.
 * Names and street addresses cannot be recognised in free text, which is why
 * the structural layer never lets the fields that hold them through.
 *
 * The input is never mutated: the SDK keeps its own copy of the scope.
 */

const REDACTED = '[redacted]';

type Json = unknown;
type Rec = Record<string, unknown>;

const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER = /\b(Bearer\s+)[^\s"',;]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const TOKEN_PATH = /\/(track|public\/trip|render)\/[A-Za-z0-9_.-]+/g;
const TOKEN_PARAM = /\b(token|secret|key|authorization|otp|pin|code|sig|signature)=[^&\s"']+/gi;
// A URL or path followed by a query string: the query is dropped wholesale —
// it can carry a search term, an address or a signed-link credential.
const QUERY = /(https?:\/\/[^\s"'<>?]*|\/[^\s"'<>?]*)\?[^\s"'<>]*/g;
// A phone-shaped run: an optional +, then digits with spaces, dots, dashes or
// brackets between them. Redacted when it holds 7 or more digits (a Guyana
// local number is 7; +592 numbers are 10).
const PHONE_RUN = /\+?\(?\d[\d\s().-]*\d/g;

export function scrubCrashText(value: string): string {
  let out = value
    .replace(JWT, REDACTED)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(EMAIL, REDACTED)
    .replace(TOKEN_PATH, `/$1/${REDACTED}`)
    .replace(TOKEN_PARAM, `$1=${REDACTED}`)
    .replace(QUERY, '$1');
  out = out.replace(PHONE_RUN, (run) => (run.replace(/\D/g, '').length >= 7 ? REDACTED : run));
  return out;
}

/** Event keys that are SDK bookkeeping, not content: copied as-is (ids, hashes, debug images). */
const PASS_THROUGH = new Set(['event_id', 'timestamp', 'start_timestamp', 'debug_meta', 'sdk', 'release', 'dist', 'platform', 'level', 'environment', 'type']);
/** Event keys that only ever describe a person. */
const DROP = new Set(['user', 'server_name', 'modules']);
const EXTRA_ALLOW = new Set(['fatal', 'source', 'componentStack']);
const CONTEXT_ALLOW = new Set(['app', 'os', 'device', 'runtime', 'culture', 'react_native_context', 'trace']);
const DEVICE_ALLOW = new Set(['model', 'model_id', 'family', 'brand', 'manufacturer', 'arch', 'simulator', 'orientation', 'low_memory']);
const DROPPED_CRUMB_CATEGORY = /^(console|touch|ui\.|xhr\.body|sentry\.event)/;

function deepText(node: Json, depth = 8): Json {
  if (typeof node === 'string') return scrubCrashText(node);
  if (node === null || typeof node !== 'object' || depth <= 0) return node;
  if (Array.isArray(node)) return node.map((v) => deepText(v, depth - 1));
  const out: Rec = {};
  for (const [k, v] of Object.entries(node as Rec)) out[k] = deepText(v, depth - 1);
  return out;
}

function pick(obj: unknown, allow: Set<string>): Rec | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const out: Rec = {};
  for (const [k, v] of Object.entries(obj as Rec)) if (allow.has(k)) out[k] = deepText(v);
  return out;
}

function routeName(value: unknown): unknown {
  if (typeof value === 'string') return scrubCrashText(value);
  if (value && typeof value === 'object' && typeof (value as Rec)['name'] === 'string') return scrubCrashText((value as Rec)['name'] as string);
  return undefined;
}

/** beforeBreadcrumb: drop crumbs that echo typing, touches or console text; strip the rest to diagnostics. */
export function scrubCrashBreadcrumb<T extends object>(crumb: T): T | null {
  const c = crumb as Rec;
  const category = typeof c['category'] === 'string' ? (c['category'] as string) : '';
  if (c['type'] === 'user' || DROPPED_CRUMB_CATEGORY.test(category)) return null;
  const out: Rec = {};
  for (const key of ['type', 'category', 'level', 'timestamp']) if (c[key] !== undefined) out[key] = c[key];
  if (typeof c['message'] === 'string') out['message'] = scrubCrashText(c['message']);
  const data = c['data'] as Rec | undefined;
  if (data && typeof data === 'object') {
    if (category === 'navigation') {
      out['data'] = { from: routeName(data['from']), to: routeName(data['to']) };
    } else if (c['type'] === 'http' || category === 'xhr' || category === 'fetch') {
      const http: Rec = {};
      if (typeof data['method'] === 'string') http['method'] = data['method'];
      if (typeof data['status_code'] === 'number') http['status_code'] = data['status_code'];
      if (typeof data['url'] === 'string') http['url'] = scrubCrashText(data['url']);
      out['data'] = http;
    }
    // Any other crumb's data is free-form app state: it is not sent.
  }
  return out as T;
}

/** beforeSend: a copy of the event with nothing that names or reaches a person. */
export function scrubCrashEvent<T extends object>(event: T): T {
  const e = event as Rec;
  const out: Rec = {};
  for (const [key, value] of Object.entries(e)) {
    if (DROP.has(key)) continue;
    if (PASS_THROUGH.has(key)) { out[key] = value; continue; }
    switch (key) {
      case 'request': {
        const url = (value as Rec | undefined)?.['url'];
        if (typeof url === 'string') out['request'] = { url: scrubCrashText(url) };
        break;
      }
      case 'extra': {
        const extra = pick(value, EXTRA_ALLOW);
        if (extra) out['extra'] = extra;
        break;
      }
      case 'contexts': {
        const contexts: Rec = {};
        for (const [name, ctx] of Object.entries((value as Rec | undefined) ?? {})) {
          if (!CONTEXT_ALLOW.has(name)) continue;
          contexts[name] = name === 'device' ? pick(ctx, DEVICE_ALLOW) : deepText(ctx);
        }
        out['contexts'] = contexts;
        break;
      }
      case 'breadcrumbs': {
        const crumbs = Array.isArray(value) ? value : [];
        out['breadcrumbs'] = crumbs
          .map((crumb) => (crumb && typeof crumb === 'object' ? scrubCrashBreadcrumb(crumb as object) : null))
          .filter((crumb) => crumb !== null);
        break;
      }
      default:
        out[key] = deepText(value);
    }
  }
  return out as T;
}
