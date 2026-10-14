import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// [CERT-ISSUER] The iOS and Android apps pin api.swiftgy.com and its
// subdomains to root keys: ISRG Root X1 and X2 (Let's Encrypt), with GTS Root
// R1 as a backup (apps/mobile/app.config.ts NSPinnedDomains and
// apps/mobile/plugins/withTlsPinning.js). Caddy obtains the certificate. Left
// to its built-in issuers it can fall back to another CA whose chain ends
// outside that pin set, and every pinned app would then be locked out of the
// API until the certificate or the app changed. So deploy/Caddyfile names its
// only issuer, Let's Encrypt's production ACME directory, for every site it
// serves (staging and production share the file).

const ROOT = join(process.cwd(), '../..');
const CADDYFILE = join(ROOT, 'deploy/Caddyfile');
const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
const ISRG_ROOT_PINS = ['C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=', 'diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI='];

/** The Caddyfile without comments or blank lines. */
const code = readFileSync(CADDYFILE, 'utf8').split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
  .filter((line) => line.trim() !== '');

/** The global options block: the first block, from `{` to the first `}` at column 0. */
function globalOptions(): string[] {
  expect(code[0], 'the Caddyfile must open with its global options block').toBe('{');
  const end = code.indexOf('}');
  expect(end).toBeGreaterThan(0);
  return code.slice(1, end).map((line) => line.trim());
}

const caddyImage = spawnSync('docker', ['image', 'inspect', 'caddy:2.10'], { encoding: 'utf8' }).status === 0;

function adapt(env: Record<string, string>): unknown {
  const args = ['run', '--rm', '--network', 'none'];
  for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`);
  args.push('-v', `${CADDYFILE}:/etc/caddy/Caddyfile:ro`, 'caddy:2.10', 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile');
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr.slice(-600)).toBe(0);
  return JSON.parse(r.stdout);
}

describe('[CERT-ISSUER] Caddy may only obtain certificates the apps\' pins accept', () => {
  it('the global options name exactly one issuer: Let\'s Encrypt\'s production ACME directory', () => {
    expect(globalOptions().filter((line) => /^cert_issuer\b/.test(line))).toEqual([`cert_issuer acme ${LETS_ENCRYPT}`]);
  });

  it('nothing else in the file can choose another issuer or CA', () => {
    const chooses = code.filter((line) => /^\s*(cert_issuer|issuer|acme_ca|acme_ca_root|acme_eab|tls|local_certs|on_demand_tls)\b/.test(line));
    expect(chooses.map((line) => line.trim())).toEqual([`cert_issuer acme ${LETS_ENCRYPT}`]);
    expect(code.join('\n').toLowerCase()).not.toContain('zerossl');
  });

  it('that issuer is the CA whose roots both apps pin (ISRG Root X1 and X2)', () => {
    const ios = readFileSync(join(ROOT, 'apps/mobile/app.config.ts'), 'utf8');
    const android = readFileSync(join(ROOT, 'apps/mobile/plugins/withTlsPinning.js'), 'utf8');
    for (const pin of ISRG_ROOT_PINS) {
      expect(ios).toContain(pin);
      expect(android).toContain(pin);
    }
  });

  // Where the stack's pinned Caddy image is present (operators, local runs),
  // the config Caddy actually runs is checked too. CI has no Caddy image and
  // relies on the two checks above.
  it.skipIf(!caddyImage)('the config Caddy runs carries only Let\'s Encrypt, with the optional names empty or set', () => {
    const hostSets: Array<Record<string, string>> = [
      { API_HOST: 'api-staging.example.com' },
      { API_HOST: 'api-staging.example.com', API_ALIAS_HOST: '', WEB_HOST: '', WEB_ALIAS_HOSTS: '', ADMIN_HOST: '' },
      { API_HOST: 'api-staging.example.com', API_ALIAS_HOST: 'api.example.com', WEB_HOST: 'staging.example.com', WEB_ALIAS_HOSTS: 'example.com www.example.com', ADMIN_HOST: 'admin-staging.example.com' },
    ];
    for (const env of hostSets) {
      const config = adapt(env) as { apps?: { tls?: { automation?: { policies?: Array<{ issuers?: unknown }> } } } };
      const policies = config.apps?.tls?.automation?.policies ?? [];
      expect(policies.length, `no issuer named for ${JSON.stringify(env)}: Caddy would use its built-in issuers`).toBeGreaterThan(0);
      for (const policy of policies) expect(policy.issuers).toEqual([{ module: 'acme', ca: LETS_ENCRYPT }]);
      expect(JSON.stringify(config).toLowerCase()).not.toContain('zerossl');
    }
  });
});
