import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  SECRET_FILE_NAMES,
  applySecretFiles,
  assembleDatabaseUrl,
} from '../utils/secret-files';

// ---------------------------------------------------------------------------
// The `*_FILE` loader: secrets reach the process as files on tmpfs, never as
// container environment variables (Docker persists those in its container
// config on disk and `docker inspect` prints them). The loader runs before any
// configuration is validated, for an explicit allowlist of names, and:
//   - reads NAME_FILE into NAME, stripping exactly one trailing newline;
//   - refuses to boot when both NAME and NAME_FILE are set, or when the file
//     is unreadable or empty;
//   - never logs a value.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swift-secret-files-'));
  dirs.push(dir);
  return dir;
}
function secretFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('the allowlist', () => {
  it('names every secret the deploy delivers through the store, and only secrets', () => {
    for (const must of [
      'POSTGRES_PASSWORD', 'DATABASE_URL',
      'JWT_SECRET', 'OTP_HASH_SECRET', 'MASTER_KEK', 'STORAGE_SIGNING_SECRET', 'MEILISEARCH_KEY',
      'TWILIO_API_KEY_SECRET', 'SMTP_PASS',
      'MMG_API_KEY', 'MMG_PASSWORD', 'MMG_MKEY', 'MMG_MSECRET',
      'PAYMENT_GATEWAY_KEY', 'PAYMENT_GATEWAY_SECRET',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      // [R2 C1] Every other secret the API reads; each could otherwise only
      // arrive through the plaintext env file the owner ruled out.
      'TEST_CONTROL_SECRET', 'METRICS_TOKEN', 'HEALTH_DETAIL_TOKEN',
      'SERVICE_PROVIDER_CURSOR_SECRET', 'VELOCITY_KEY_SECRET', 'ADS_EVENT_SECRET',
      'AGENT_CASH_WEBHOOK_SECRET', 'SWIFT_BOOTSTRAP_PASSWORD', 'GOOGLE_MAPS_API_KEY_BACKEND',
      'ATTRIB_SALT', 'IDENTITY_SALT', 'SCAN_IP_SALT', 'SENTRY_DSN',
    ]) {
      expect(SECRET_FILE_NAMES, must).toContain(must);
    }
    // Identifiers, hostnames and switches are configuration, not secrets: a
    // *_FILE for them would be a file-read primitive with no purpose.
    for (const never of ['NODE_ENV', 'LOG_LEVEL', 'API_HOST', 'TWILIO_ACCOUNT_SID', 'TWILIO_FROM', 'MMG_MERCHANT_ID', 'KYC_PROVIDER']) {
      expect(SECRET_FILE_NAMES).not.toContain(never);
    }
    // [R2 C3] AI identity providers are forbidden by the no-AI rule; no store
    // may ever carry their keys.
    for (const forbidden of ['DIDIT_API_KEY', 'ID_ANALYZER_API_KEY']) {
      expect(SECRET_FILE_NAMES).not.toContain(forbidden);
    }
    expect(new Set(SECRET_FILE_NAMES).size).toBe(SECRET_FILE_NAMES.length);
    for (const name of SECRET_FILE_NAMES) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    for (const name of SECRET_FILE_NAMES) expect(name.endsWith('_FILE')).toBe(false);
  });
});

describe('the allowlist census — no secret the API reads can fall back to the env file', () => {
  // [R2 C1] Every environment name the API source reads whose spelling looks
  // like a secret is either deliverable through the store (allowlisted), or a
  // documented non-secret, or a forbidden provider key. A new secret-shaped
  // read anywhere in apps/api/src fails here until it is classified, so the
  // gap that R1 shipped with cannot reopen.
  const SRC = join(__dirname, '..');
  const SECRET_SHAPE = /(KEY|KEK|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIAL|DSN|PRIVATE|AUTH|SALT|PEPPER|SIGNING|HMAC|CERT)/;
  const PUBLIC_PREFIX = /^(EXPO_PUBLIC|NEXT_PUBLIC|VITE)_/;
  const READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])|\benv(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;

  /** Secret-shaped by spelling, settings by nature. Each carries its reason. */
  const NON_SECRET: Record<string, string> = {
    DEV_OTP_BYPASS: 'a development switch (0/1), refused in production by the boot guard',
    MASTER_KEK_ESCROW_FINGERPRINT: 'the sha256 of the key bytes, recorded beside the key on purpose so a stale escrow is caught',
    NOT_MY_DRIVER_AUTHORITY_KILL: 'a kill switch for a dispatch rule',
    SOCKET_AUTH_RECHECK_MS: 'a timing for the socket re-authentication sweep',
    SOCKET_AUTH_RECHECK_TIMEOUT_MS: 'a timing for the socket re-authentication sweep',
    SWEEP_MAX_PASS_SECONDS: 'a timing bound for a sweep pass',
    TWILIO_API_KEY_SID: 'the key identifier (the HTTP Basic username); the secret half is TWILIO_API_KEY_SECRET',
  };
  /** Never deliverable: the owner's no-AI rule forbids these providers (#1276 removes the readers). */
  const FORBIDDEN: Record<string, string> = {
    DIDIT_API_KEY: 'AI identity provider, forbidden',
    ID_ANALYZER_API_KEY: 'AI identity provider, forbidden',
  };

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'generated') continue;
        sourceFiles(path, out);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(path);
      }
    }
    return out;
  }

  const reads = new Map<string, Set<string>>();
  for (const file of sourceFiles(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(READ)) {
      const name = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!name) continue;
      if (!reads.has(name)) reads.set(name, new Set());
      reads.get(name)?.add(relative(SRC, file));
    }
  }
  const secretShaped = [...reads.keys()].filter((n) => SECRET_SHAPE.test(n) && !PUBLIC_PREFIX.test(n)).sort();
  const allowlisted = new Set<string>(SECRET_FILE_NAMES);

  it('scanned a real tree', () => {
    expect(reads.size).toBeGreaterThan(50);
    expect(secretShaped.length).toBeGreaterThan(20);
    expect(reads.has('JWT_SECRET')).toBe(true);
  });

  it('classifies every secret-shaped read', () => {
    const unclassified = secretShaped.filter((n) => !allowlisted.has(n) && !(n in NON_SECRET) && !(n in FORBIDDEN));
    expect(
      unclassified.map((n) => `${n} (${[...(reads.get(n) ?? [])].join(', ')})`),
      'add the name to SECRET_FILE_NAMES (deliverable through the store) or to NON_SECRET with its reason',
    ).toEqual([]);
  });

  it('a forbidden provider key is never allowlisted', () => {
    for (const name of Object.keys(FORBIDDEN)) expect(allowlisted.has(name), name).toBe(false);
  });

  it('every non-secret exemption still names a real read and a real reason', () => {
    for (const [name, reason] of Object.entries(NON_SECRET)) {
      expect(reads.has(name), `${name} is no longer read anywhere — remove the exemption`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
      expect(allowlisted.has(name), `${name} cannot be both allowlisted and exempt`).toBe(false);
    }
  });
});

describe('applySecretFiles — reading', () => {
  it('reads NAME_FILE into NAME and strips exactly one trailing newline', () => {
    const dir = scratch();
    const env: Record<string, string | undefined> = {
      JWT_SECRET_FILE: secretFile(dir, 'JWT_SECRET', 'jwt-value-one\n'),
      MASTER_KEK_FILE: secretFile(dir, 'MASTER_KEK', 'kek-value-two'),
      SMTP_PASS_FILE: secretFile(dir, 'SMTP_PASS', 'crlf-value\r\n'),
      MMG_MSECRET_FILE: secretFile(dir, 'MMG_MSECRET', 'keeps-inner\nnewline\n\n'),
      TWILIO_API_KEY_SECRET_FILE: secretFile(dir, 'TWILIO_API_KEY_SECRET', '  padded  '),
    };
    const loaded = applySecretFiles(env);
    expect(env['JWT_SECRET']).toBe('jwt-value-one');
    expect(env['MASTER_KEK']).toBe('kek-value-two');
    expect(env['SMTP_PASS']).toBe('crlf-value');
    // ONE newline, not all of them, and never inner whitespace: a secret is bytes.
    expect(env['MMG_MSECRET']).toBe('keeps-inner\nnewline\n');
    expect(env['TWILIO_API_KEY_SECRET']).toBe('  padded  ');
    expect([...loaded].sort()).toEqual(['JWT_SECRET', 'MASTER_KEK', 'MMG_MSECRET', 'SMTP_PASS', 'TWILIO_API_KEY_SECRET']);
  });

  it('removes NAME_FILE once loaded, so a second pass is a no-op rather than a "both set" refusal', () => {
    const dir = scratch();
    const env: Record<string, string | undefined> = { JWT_SECRET_FILE: secretFile(dir, 'JWT_SECRET', 'v') };
    applySecretFiles(env);
    expect(env['JWT_SECRET_FILE']).toBeUndefined();
    expect(applySecretFiles(env)).toEqual([]);
    expect(env['JWT_SECRET']).toBe('v');
  });

  it('ignores a NAME_FILE for a name outside the allowlist — no file-read primitive for arbitrary names', () => {
    const dir = scratch();
    const env: Record<string, string | undefined> = {
      LOG_LEVEL_FILE: secretFile(dir, 'LOG_LEVEL', 'debug'),
      NODE_ENV_FILE: '/etc/hostname',
      SOMETHING_ELSE_FILE: secretFile(dir, 'SOMETHING_ELSE', 'x'),
    };
    expect(applySecretFiles(env)).toEqual([]);
    expect(env['LOG_LEVEL']).toBeUndefined();
    expect(env['NODE_ENV']).toBeUndefined();
    expect(env['SOMETHING_ELSE']).toBeUndefined();
    expect(env['LOG_LEVEL_FILE']).toBe(join(dir, 'LOG_LEVEL'));
  });

  it('leaves an env with no *_FILE entries untouched', () => {
    const env: Record<string, string | undefined> = { JWT_SECRET: 'plain', NODE_ENV: 'test' };
    expect(applySecretFiles(env)).toEqual([]);
    expect(env).toEqual({ JWT_SECRET: 'plain', NODE_ENV: 'test' });
  });

  it('treats an empty NAME_FILE as unset', () => {
    const env: Record<string, string | undefined> = { JWT_SECRET: 'plain', JWT_SECRET_FILE: '' };
    expect(applySecretFiles(env)).toEqual([]);
    expect(env['JWT_SECRET']).toBe('plain');
  });
});

describe('applySecretFiles — refusals', () => {
  it('refuses when both NAME and NAME_FILE are set, naming the variables and neither value', () => {
    const dir = scratch();
    const env: Record<string, string | undefined> = {
      JWT_SECRET: 'inline-value-abc',
      JWT_SECRET_FILE: secretFile(dir, 'JWT_SECRET', 'file-value-xyz'),
    };
    let message = '';
    try {
      applySecretFiles(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('JWT_SECRET_FILE');
    expect(message).not.toContain('inline-value-abc');
    expect(message).not.toContain('file-value-xyz');
  });

  it('an empty NAME does not count as set — a template placeholder must not block the file', () => {
    const dir = scratch();
    const env: Record<string, string | undefined> = {
      JWT_SECRET: '',
      JWT_SECRET_FILE: secretFile(dir, 'JWT_SECRET', 'from-file'),
    };
    expect(applySecretFiles(env)).toEqual(['JWT_SECRET']);
    expect(env['JWT_SECRET']).toBe('from-file');
  });

  it('refuses a missing file, naming the variable, the path and the reason', () => {
    const dir = scratch();
    const missing = join(dir, 'MASTER_KEK');
    const env: Record<string, string | undefined> = { MASTER_KEK_FILE: missing };
    expect(() => applySecretFiles(env)).toThrow(/MASTER_KEK_FILE/);
    expect(() => applySecretFiles(env)).toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(() => applySecretFiles(env)).toThrow(/ENOENT/);
    expect(env['MASTER_KEK']).toBeUndefined();
  });

  it('refuses an unreadable file and never reveals its content', () => {
    if (isRoot) return; // root reads everything; nothing to prove here
    const dir = scratch();
    const path = secretFile(dir, 'OTP_HASH_SECRET', 'the-hidden-content');
    chmodSync(path, 0o000);
    const env: Record<string, string | undefined> = { OTP_HASH_SECRET_FILE: path };
    let message = '';
    try {
      applySecretFiles(env);
    } catch (error) {
      message = (error as Error).message;
    } finally {
      chmodSync(path, 0o600);
    }
    expect(message).toContain('OTP_HASH_SECRET_FILE');
    expect(message).toContain('EACCES');
    expect(message).not.toContain('the-hidden-content');
    expect(env['OTP_HASH_SECRET']).toBeUndefined();
  });

  it('refuses an empty file, and a file holding only a newline', () => {
    const dir = scratch();
    expect(() => applySecretFiles({ JWT_SECRET_FILE: secretFile(dir, 'JWT_SECRET', '') })).toThrow(/JWT_SECRET_FILE.*empty/);
    expect(() => applySecretFiles({ MEILISEARCH_KEY_FILE: secretFile(dir, 'MEILISEARCH_KEY', '\n') })).toThrow(/MEILISEARCH_KEY_FILE.*empty/);
  });

  it('refuses a directory', () => {
    const dir = scratch();
    expect(() => applySecretFiles({ JWT_SECRET_FILE: dir })).toThrow(/JWT_SECRET_FILE/);
  });

  it('stops at the first problem and leaves nothing half-loaded from the failing name', () => {
    const dir = scratch();
    const env: Record<string, string | undefined> = {
      JWT_SECRET_FILE: secretFile(dir, 'JWT_SECRET', 'ok'),
      MASTER_KEK_FILE: join(dir, 'nope'),
    };
    expect(() => applySecretFiles(env)).toThrow(/MASTER_KEK_FILE/);
    expect(env['MASTER_KEK']).toBeUndefined();
  });
});

describe('applySecretFiles — silence', () => {
  it('never writes a value to the console, on success or on refusal', () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    const dir = scratch();
    applySecretFiles({ JWT_SECRET_FILE: secretFile(dir, 'JWT_SECRET', 'quiet-value') });
    try {
      applySecretFiles({ JWT_SECRET: 'loud-value', JWT_SECRET_FILE: secretFile(dir, 'JWT_SECRET2', 'x') });
    } catch {
      // expected
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('assembleDatabaseUrl — the database credential from parts', () => {
  it('builds DATABASE_URL from POSTGRES_* parts with every component percent-encoded', () => {
    const env: Record<string, string | undefined> = {
      POSTGRES_HOST: 'postgres',
      POSTGRES_PORT: '5432',
      POSTGRES_USER: 'swift',
      POSTGRES_DB: 'swift',
      POSTGRES_PASSWORD: 'p@ss:w/ord#?&=%',
    };
    expect(assembleDatabaseUrl(env)).toBe(true);
    expect(env['DATABASE_URL']).toBe('postgresql://swift:p%40ss%3Aw%2Ford%23%3F%26%3D%25@postgres:5432/swift');
    expect(new URL(env['DATABASE_URL'] as string).password).toBe('p%40ss%3Aw%2Ford%23%3F%26%3D%25');
    expect(decodeURIComponent(new URL(env['DATABASE_URL'] as string).password)).toBe('p@ss:w/ord#?&=%');
  });

  it('defaults the port to 5432 and encodes user and database names too', () => {
    const env: Record<string, string | undefined> = {
      POSTGRES_HOST: 'db.internal',
      POSTGRES_USER: 'swift app',
      POSTGRES_DB: 'swift/pilot',
      POSTGRES_PASSWORD: 'hex0123',
    };
    expect(assembleDatabaseUrl(env)).toBe(true);
    expect(env['DATABASE_URL']).toBe('postgresql://swift%20app:hex0123@db.internal:5432/swift%2Fpilot');
  });

  it('does nothing when DATABASE_URL is already set and no parts are given', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgresql://a:b@c:5432/d' };
    expect(assembleDatabaseUrl(env)).toBe(false);
    expect(env['DATABASE_URL']).toBe('postgresql://a:b@c:5432/d');
  });

  it('does nothing when no password is present — the missing credential is reported downstream, not invented', () => {
    const env: Record<string, string | undefined> = { POSTGRES_HOST: 'postgres', POSTGRES_USER: 'swift', POSTGRES_DB: 'swift' };
    expect(assembleDatabaseUrl(env)).toBe(false);
    expect(env['DATABASE_URL']).toBeUndefined();
  });

  it('refuses when both DATABASE_URL and POSTGRES_PASSWORD are set — one place, never two', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: 'postgresql://a:url-secret@c:5432/d',
      POSTGRES_PASSWORD: 'part-secret',
      POSTGRES_HOST: 'postgres',
      POSTGRES_USER: 'swift',
      POSTGRES_DB: 'swift',
    };
    let message = '';
    try {
      assembleDatabaseUrl(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/POSTGRES_PASSWORD/);
    expect(message).not.toContain('url-secret');
    expect(message).not.toContain('part-secret');
  });

  it('refuses a password without the host, user and database it belongs to', () => {
    expect(() => assembleDatabaseUrl({ POSTGRES_PASSWORD: 'x', POSTGRES_USER: 'u', POSTGRES_DB: 'd' })).toThrow(/POSTGRES_HOST/);
    expect(() => assembleDatabaseUrl({ POSTGRES_PASSWORD: 'x', POSTGRES_HOST: 'h', POSTGRES_DB: 'd' })).toThrow(/POSTGRES_USER/);
    expect(() => assembleDatabaseUrl({ POSTGRES_PASSWORD: 'x', POSTGRES_HOST: 'h', POSTGRES_USER: 'u' })).toThrow(/POSTGRES_DB/);
    expect(() => assembleDatabaseUrl({ POSTGRES_PASSWORD: 'x', POSTGRES_HOST: 'h', POSTGRES_USER: 'u', POSTGRES_DB: 'd', POSTGRES_PORT: 'abc' })).toThrow(/POSTGRES_PORT/);
    expect(() => assembleDatabaseUrl({ POSTGRES_PASSWORD: 'x', POSTGRES_HOST: 'h/evil', POSTGRES_USER: 'u', POSTGRES_DB: 'd' })).toThrow(/POSTGRES_HOST/);
  });

  it('composes with the file loader: a password delivered as a file becomes a usable URL', () => {
    const dir = scratch();
    const env: Record<string, string | undefined> = {
      POSTGRES_PASSWORD_FILE: secretFile(dir, 'POSTGRES_PASSWORD', 'deadbeef\n'),
      POSTGRES_HOST: 'postgres',
      POSTGRES_PORT: '5432',
      POSTGRES_USER: 'swift',
      POSTGRES_DB: 'swift',
    };
    expect(applySecretFiles(env)).toEqual(['POSTGRES_PASSWORD']);
    expect(assembleDatabaseUrl(env)).toBe(true);
    expect(env['DATABASE_URL']).toBe('postgresql://swift:deadbeef@postgres:5432/swift');
  });
});

describe('boot order — the loader runs before any module can read process.env', () => {
  const src = join(__dirname, '..');
  const firstImport = (file: string): string => {
    const text = readFileSync(join(src, file), 'utf8');
    const match = text.match(/^import\b[^\n]*$/m);
    return match ? match[0] : '';
  };

  it.each(['server.ts', 'worker.ts', 'boot/migrate-deploy.ts'])('%s imports ./boot/secret-files before anything else', (file) => {
    // Imports are hoisted and evaluated in order (CommonJS output preserves
    // it), so only a FIRST side-effect import runs before a module-scope
    // `process.env[...]` read anywhere in the import graph.
    expect(firstImport(file)).toMatch(/^import '\.\.?\/(boot\/)?secret-files';$/);
  });

  it('the boot module applies the loader and the URL assembly to process.env, and exits on refusal without a value', () => {
    const text = readFileSync(join(src, 'boot', 'secret-files.ts'), 'utf8');
    expect(text).toContain('applySecretFiles(process.env)');
    expect(text).toContain('assembleDatabaseUrl(process.env)');
    expect(text).toContain('process.exit(1)');
    // Only the message is printed — a stack would be noise, and a value would be a leak.
    expect(text).not.toMatch(/console\.error\((err|error)\)/);
  });
});
