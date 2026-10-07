import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { connectSelfCheckRedis, formatSelfCheck, runPaymentsSelfCheck } from '../modules/billing/payments-self-check';
import { POWERTRANZ_ENV } from '../providers/card/powertranz-provider';
import { applySecretFiles, SECRET_FILE_NAMES } from '../utils/secret-files';

// ---------------------------------------------------------------------------
// [PT-5] The owner's payments setup: the server-side self-check prints only
// OK / FAIL lines (a FAIL may name a SETTING, never a value), and the owner
// tool asks for exactly the provider's secrets at hidden prompts (PEM keys by
// FILE), sends them on stdin only, and switches nothing on.
// ---------------------------------------------------------------------------

const PASSWORD = `pw-${nanoid(16)}`;
const CARD_ENV = {
  NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'sandbox', CARD_RAIL_ACCOUNT: 'swift-gy',
  POWERTRANZ_ID: 'TESTID01', POWERTRANZ_PASSWORD: PASSWORD, POWERTRANZ_PAGE_SET: 'PTZ/Swift', POWERTRANZ_PAGE_NAME: 'Weekly',
  API_PUBLIC_URL: 'https://api.example.test',
};
let redis: Redis;

/** A fake card gateway answering in the guide's shapes. `credentials` also
 *  models answers that say nothing about them (another status, no JSON, a
 *  system error, no answer at all). */
type ProbeAnswer = boolean | 'http404' | 'http500' | 'not-json' | 'system-error' | 'no-answer';
function gateway(opts: { alive?: boolean; credentials?: ProbeAnswer; page?: boolean } = {}) {
  const paths: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetch = (async (url: string | URL, init?: Parameters<typeof globalThis.fetch>[1]) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])));
    if (path === '/api/alive') {
      if (opts.alive === false) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    }
    if (path === '/api/spi/riskmgmt') {
      if (opts.credentials === 'no-answer') throw new TypeError('fetch failed');
      if (opts.credentials === 'http404') return new Response('not found', { status: 404 });
      if (opts.credentials === 'http500') return new Response(JSON.stringify({ Errors: [{ Code: '999', Message: 'Server error' }] }), { status: 500 });
      if (opts.credentials === 'not-json') return new Response('<html>maintenance</html>', { status: 200 });
      if (opts.credentials === 'system-error') return new Response(JSON.stringify({ Approved: false, IsoResponseCode: '96' }), { status: 200 });
      return new Response(JSON.stringify(opts.credentials === false
        ? { Approved: false, IsoResponseCode: '89', Errors: [{ Code: '312', Message: 'Invalid credentials' }] }
        : { Approved: false, IsoResponseCode: '97', Errors: [{ Code: '37', Message: 'Missing field(s)' }] }), { status: 200 });
    }
    if (path === '/api/spi/sale') {
      const req = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(opts.page === false
        ? { Approved: false, IsoResponseCode: '12', Errors: [{ Code: '757', Message: 'Hosted page not found' }] }
        : { IsoResponseCode: 'SP4', TransactionIdentifier: req['TransactionIdentifier'], RedirectData: '<form></form>', SpiToken: 'spi-synthetic' }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, paths, headers };
}

beforeAll(() => {
  redis = new Redis(process.env['REDIS_URL']!);
});
afterAll(async () => {
  const keys = await redis.keys('ptz:selfcheck:*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

describe('the card self-check', () => {
  it('everything in order: OK lines only, and nothing completed or charged', async () => {
    const gw = gateway();
    const lines = await runPaymentsSelfCheck(['card'], CARD_ENV, { redis, fetch: gw.fetch });
    expect(formatSelfCheck(lines)).toBe([
      'OK   card: settings complete',
      'OK   card: gateway reachable',
      'OK   card: credentials accepted',
      'OK   card: hosted payment page set up',
    ].join('\n'));
    expect(gw.paths).not.toContain('/api/spi/payment');
  });

  it('refused credentials, an unreachable gateway, an unknown page: FAIL lines that never carry a value', async () => {
    const gw = gateway({ alive: false, credentials: false, page: false });
    const printed = formatSelfCheck(await runPaymentsSelfCheck(['card'], CARD_ENV, { redis, fetch: gw.fetch }));
    expect(printed).toBe([
      'OK   card: settings complete',
      'FAIL card: gateway reachable',
      'FAIL card: credentials accepted',
      'FAIL card: hosted payment page set up',
    ].join('\n'));
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain('TESTID01');
  });

  it('a missing setting names the setting, never a value; another provider is a plain FAIL', async () => {
    const printed = formatSelfCheck(await runPaymentsSelfCheck(['card'], { ...CARD_ENV, POWERTRANZ_PAGE_SET: '' }, { redis, fetch: gateway().fetch }));
    expect(printed).toBe('FAIL card: settings complete (POWERTRANZ_PAGE_SET, POWERTRANZ_PAGE_NAME)');
    expect(formatSelfCheck(await runPaymentsSelfCheck(['card'], { ...CARD_ENV, POWERTRANZ_PASSWORD: '' }, { redis }))).toBe('FAIL card: settings complete (POWERTRANZ_PASSWORD)');
    expect(formatSelfCheck(await runPaymentsSelfCheck(['card'], { ...CARD_ENV, CARD_RAIL_PROVIDER: 'simulator' }, { redis }))).toBe('FAIL card: CARD_RAIL_PROVIDER is set to powertranz');
  });

  it('[DS845 S3] an answer that says nothing about the credentials (404, 5xx, not JSON, a system error, no answer): FAIL, "could not tell" — never "accepted"', async () => {
    for (const credentials of ['http404', 'http500', 'not-json', 'system-error', 'no-answer'] as const) {
      const printed = formatSelfCheck(await runPaymentsSelfCheck(['card'], CARD_ENV, { redis, fetch: gateway({ credentials }).fetch }));
      expect(printed.split('\n'), credentials).toContain('FAIL card: credentials accepted (could not tell: the gateway gave no readable answer)');
      expect(printed, credentials).not.toContain('OK   card: credentials accepted');
    }
  });

  it('[DS845 S4] a Redis that cannot be reached: a plain FAIL line, no client error printed', async () => {
    const printedErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await connectSelfCheckRedis('redis://127.0.0.1:1')).toBeUndefined();
      expect(await connectSelfCheckRedis(undefined)).toBeUndefined();
      await new Promise((r) => setTimeout(r, 200));
      expect(printedErrors).not.toHaveBeenCalled();
    } finally { printedErrors.mockRestore(); }
    expect(formatSelfCheck(await runPaymentsSelfCheck(['card'], CARD_ENV, {}))).toBe('FAIL card: the self-check reaches Redis (REDIS_URL)');
    const reachable = await connectSelfCheckRedis(process.env['REDIS_URL']);
    try {
      expect(await reachable?.ping()).toBe('PONG');
    } finally { reachable?.disconnect(); }
  });

  it('[#1520 review S3] live cards on any server but production: FAIL, naming the setting — a test server never takes real cards', async () => {
    const gw = gateway();
    const printed = formatSelfCheck(await runPaymentsSelfCheck(['card'], { ...CARD_ENV, CARD_RAIL_ENVIRONMENT: 'live', POWERTRANZ_API_URL: 'https://gateway.ptranz.com' }, { redis, fetch: gw.fetch }));
    expect(printed).toBe('FAIL card: settings complete (CARD_RAIL_ENVIRONMENT)');
    expect(gw.paths).toEqual([]);
  });
});

describe('the MMG checkout self-check', () => {
  const pair = (bits: number) => generateKeyPairSync('rsa', { modulusLength: bits, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const strong = pair(4096);
  const ours = pair(4096);
  const SECRET = `mmg-secret-${nanoid(10)}`;
  const mmgEnv = (over: Record<string, string> = {}) => ({
    NODE_ENV: 'development', MMG_CHECKOUT_MERCHANT_ID: '1234567', MMG_CHECKOUT_CLIENT_ID: 'client-synthetic', MMG_CHECKOUT_MERCHANT_NAME: 'Swift Test',
    MMG_CHECKOUT_SECRET_KEY: SECRET, MMG_CHECKOUT_RETURN_ORIGIN: 'https://web.example.test',
    MMG_CHECKOUT_PUBLIC_KEY: strong.publicKey, MMG_CHECKOUT_PRIVATE_KEY: ours.privateKey, MMG_DRIVER: 'live', ...over,
  });

  it('keys load, both 4096-bit, a test request encrypts within 446 bytes, the merchant login answers', async () => {
    const printed = formatSelfCheck(await runPaymentsSelfCheck(['mmg'], mmgEnv(), { mmgLogin: async () => ({ token: 'synthetic' }) }));
    expect(printed).toBe([
      'OK   mmg: checkout settings and keys load',
      'OK   mmg: the request key (MMG_CHECKOUT_PUBLIC_KEY) is 4096-bit',
      'OK   mmg: the reply key (MMG_CHECKOUT_PRIVATE_KEY) is 4096-bit',
      "OK   mmg: a test request encrypts within the key's limit (446 bytes)",
      'OK   mmg: the merchant login works',
    ].join('\n'));
    expect(printed).not.toContain(SECRET);
  });

  it('a 2048-bit key, a failed login, the sandbox driver, a missing setting: FAIL lines, never a value', async () => {
    const weak = pair(2048);
    // A 2048-bit request key cannot even carry MMG's widest request: loading names the key.
    expect(formatSelfCheck(await runPaymentsSelfCheck(['mmg'], mmgEnv({ MMG_CHECKOUT_PUBLIC_KEY: weak.publicKey }), {})))
      .toMatch(/^FAIL mmg: checkout settings and keys load \(MMG_CHECKOUT_PUBLIC_KEY/);
    const lines = formatSelfCheck(await runPaymentsSelfCheck(['mmg'], mmgEnv({ MMG_CHECKOUT_PRIVATE_KEY: weak.privateKey }), { mmgLogin: async () => { throw new Error('denied'); } }));
    expect(lines).toContain('OK   mmg: the request key (MMG_CHECKOUT_PUBLIC_KEY) is 4096-bit');
    expect(lines).toContain('FAIL mmg: the reply key (MMG_CHECKOUT_PRIVATE_KEY) is 4096-bit');
    expect(lines).toContain('FAIL mmg: the merchant login works');
    expect(formatSelfCheck(await runPaymentsSelfCheck(['mmg'], mmgEnv({ MMG_DRIVER: 'sandbox' }), {}))).toContain('FAIL mmg: MMG_DRIVER is live');
    const missing = formatSelfCheck(await runPaymentsSelfCheck(['mmg'], mmgEnv({ MMG_CHECKOUT_SECRET_KEY: '' }), {}));
    expect(missing).toBe('FAIL mmg: checkout settings and keys load (MMG_CHECKOUT_SECRET_KEY, MMG_CHECKOUT_ENABLED, MMG_DRIVER)');
    expect(missing).not.toContain(SECRET);
  });
});

describe('the owner tool: deploy/owner/swift-payments-setup.command', () => {
  const path = join(process.cwd(), '../../deploy/owner/swift-payments-setup.command');
  const tool = readFileSync(path, 'utf8');
  const code = tool.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('is executable and valid bash', () => {
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(spawnSync('bash', ['-n', path]).status).toBe(0);
  });

  it('asks for exactly the providers\' secrets — every one a store secret — hidden, and PEM keys only by file', () => {
    for (const name of POWERTRANZ_ENV.secrets) {
      expect(code, name).toMatch(new RegExp(`ask_hidden ${name}\\b`));
      expect(SECRET_FILE_NAMES as readonly string[]).toContain(name);
    }
    expect(code).toMatch(/ask_hidden MMG_CHECKOUT_SECRET_KEY\b/);
    expect(code).toMatch(/send_pem MMG_CHECKOUT_PRIVATE_KEY PRIVATE/);
    expect(code).toMatch(/send_pem MMG_CHECKOUT_PUBLIC_KEY PUBLIC/);
    for (const name of ['MMG_CHECKOUT_SECRET_KEY', 'MMG_CHECKOUT_PRIVATE_KEY', 'MMG_CHECKOUT_PUBLIC_KEY']) expect(SECRET_FILE_NAMES as readonly string[]).toContain(name);
    const asked = [...code.matchAll(/(?:ask_hidden|send_pem) ([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]).sort();
    expect(asked).toEqual(['MMG_CHECKOUT_PRIVATE_KEY', 'MMG_CHECKOUT_PUBLIC_KEY', 'MMG_CHECKOUT_SECRET_KEY', 'POWERTRANZ_GATEWAY_KEY', 'POWERTRANZ_ID', 'POWERTRANZ_PASSWORD']);
  });

  it('a value only ever travels on stdin to the store, is never echoed, and the tool prints only "saved NAME"', () => {
    expect(code).toMatch(/IFS= read -r -s -p "Value for \$name/);
    expect(code).toMatch(/printf '%s' "\$value" \| "\$\{SSH\[@\]\}" "sudo -n swift-secrets set \$name"/);
    expect(code).toMatch(/cat -- "\$path" \| "\$\{SSH\[@\]\}" "sudo -n swift-secrets set \$name"/);
    expect(code).not.toMatch(/echo\s+"?\$value|say\s+"?\$value|\$\{value\}/);
    expect(code).not.toMatch(/mktemp|> ?\/tmp|tee /);
    expect(code).toMatch(/echo "saved \$name"/);
  });

  it('[review S4] asks for the account label and this server\'s public address; uses a gateway key only when entered in this run; says plainly when the check could not run', () => {
    expect(code).toMatch(/"CARD_RAIL_ACCOUNT=\$account"/);
    expect(code).toMatch(/"API_PUBLIC_URL=\$public_url"/);
    expect(code).not.toMatch(/swift-secrets list/);
    expect(code).toMatch(/gateway_key_saved="\$LAST_SAVED"/);
    expect(code).toMatch(/no OK \/ FAIL lines came back/);
  });

  describe('[DS845 S2] run for real (fake ssh, sudo and docker on PATH; nothing leaves this machine): the check carries exactly this run\'s values', () => {
    const STALE = { POWERTRANZ_GATEWAY_KEY_FILE: '/run/secrets/POWERTRANZ_GATEWAY_KEY', POWERTRANZ_API_URL: 'https://gateway.ptranz.com' };
    const ID = 'TESTID01';
    const PW = `pw-${nanoid(12)}`;
    const KEY = randomUUID(); // sec. 4: the gateway key is a GUID (synthetic here)

    /** Runs the tool with typed answers; returns the one-off container's EFFECTIVE settings: the
     *  server's deploy/.env (with values an earlier run left: STALE) overridden by the tool's -e flags,
     *  as docker compose merges them, plus what the tool printed and the secrets it sent. */
    function runTool(answers: string[]) {
      const dir = mkdtempSync(join(tmpdir(), 'swift-setup-'));
      try {
        const bin = join(dir, 'bin');
        const sent = join(dir, 'sent');
        mkdirSync(bin);
        mkdirSync(sent);
        const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
        // ssh: run the remote command here, as the host's shell would (the last argument).
        script('ssh', 'exec env PATH="$FAKE_BIN:$PATH" bash -c "${@: -1}"');
        // sudo: the secret store keeps what arrives on stdin; anything else succeeds.
        script('sudo', 'if [ "$2" = swift-secrets ] && [ "$3" = set ]; then cat > "$FAKE_SENT/$4"; fi\nexit 0');
        // docker: record the one-off container's arguments, answer like the self-check.
        script('docker', 'printf "%s\\n" "$@" > "$FAKE_SENT/docker-args"\nprintf "OK   card: settings complete\\n"');
        const key = join(dir, 'id_test');
        writeFileSync(key, 'not a key');
        const run = spawnSync('bash', [path, 'swift-deploy@host.example.test', key, 'card'], {
          input: `${answers.join('\n')}\n`, encoding: 'utf8', timeout: 30_000,
          env: { PATH: `${bin}:${process.env['PATH']}`, HOME: dir, FAKE_BIN: bin, FAKE_SENT: sent, SWIFT_DIR: dir },
        });
        expect(run.status, run.stderr).toBe(0);
        const args = readFileSync(join(sent, 'docker-args'), 'utf8').split('\n');
        const flags: Record<string, string> = {};
        args.forEach((a, i) => {
          if (args[i - 1] !== '-e') return;
          const at = a.indexOf('=');
          flags[a.slice(0, at)] = a.slice(at + 1);
        });
        const secrets: Record<string, string> = {};
        for (const name of ['POWERTRANZ_ID', 'POWERTRANZ_PASSWORD', 'POWERTRANZ_GATEWAY_KEY']) {
          if (existsSync(join(sent, name))) secrets[`/run/secrets/${name}`] = readFileSync(join(sent, name), 'utf8');
        }
        return { effective: { ...STALE, ...flags } as Record<string, string | undefined>, printed: run.stderr, secrets };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    /** The self-check the container would run on those settings (secret files read from what the tool sent). */
    async function checkOn(run: ReturnType<typeof runTool>) {
      const env = { ...run.effective, NODE_ENV: 'development' };
      applySecretFiles(env, { readFileSync: (file: string) => {
        const value = run.secrets[file];
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return Buffer.from(value);
      } } as never);
      const gw = gateway();
      return { printed: formatSelfCheck(await runPaymentsSelfCheck(['card'], env, { redis, fetch: gw.fetch })), gw };
    }
    const sandbox = ['sandbox', 'swift-gy', 'https://api.example.test', 'PTZ/Swift', 'Weekly', ID, ID, PW, PW];

    it('gateway key skipped, test system: a key and a live address left by an earlier run are NOT checked — and the printed settings clear them', async () => {
      const run = runTool([...sandbox, '']);
      expect(run.effective['POWERTRANZ_GATEWAY_KEY_FILE']).toBe('');
      expect(run.effective['POWERTRANZ_API_URL']).toBe('');
      expect(run.printed).toMatch(/^ {2}POWERTRANZ_GATEWAY_KEY_FILE=$/m);
      expect(run.printed).toMatch(/^ {2}POWERTRANZ_API_URL=$/m);
      const { printed, gw } = await checkOn(run);
      expect(printed).toBe([
        'OK   card: settings complete', 'OK   card: gateway reachable', 'OK   card: credentials accepted', 'OK   card: hosted payment page set up',
      ].join('\n'));
      expect(gw.headers.some((h) => 'powertranz-gatewaykey' in h)).toBe(false);
      expect(run.printed).not.toContain(PW);
    });

    it('gateway key entered in this run: exactly that key is checked', async () => {
      const run = runTool([...sandbox, KEY, KEY]);
      expect(run.effective['POWERTRANZ_GATEWAY_KEY_FILE']).toBe('/run/secrets/POWERTRANZ_GATEWAY_KEY');
      expect(run.printed).toMatch(/^ {2}POWERTRANZ_GATEWAY_KEY_FILE=\/run\/secrets\/POWERTRANZ_GATEWAY_KEY$/m);
      const { printed, gw } = await checkOn(run);
      expect(printed).toContain('OK   card: credentials accepted');
      const probe = gw.headers[gw.paths.indexOf('/api/spi/riskmgmt')]!;
      expect(probe['powertranz-gatewaykey']).toBe(KEY);
      expect(run.printed).not.toContain(KEY);
    });

    it('live cards: exactly the production address entered in this run is checked', () => {
      const run = runTool(['live', 'swift-gy', 'https://api.example.test', 'PTZ/Swift', 'Weekly', 'https://gateway2.ptranz.com', ID, ID, PW, PW, '']);
      expect(run.effective['POWERTRANZ_API_URL']).toBe('https://gateway2.ptranz.com');
      expect(run.effective['CARD_RAIL_ENVIRONMENT']).toBe('live');
      expect(run.effective['POWERTRANZ_GATEWAY_KEY_FILE']).toBe('');
    });
  });

  it('checks on the server with the self-check, in a one-off container, and switches nothing on', () => {
    expect(code).toContain('node dist/boot/payments-self-check.js');
    expect(code).toMatch(/run --rm --no-deps/);
    expect(code).not.toMatch(/CARD_RAIL_V2=1|CARD_RAIL_ENROLL|MMG_CHECKOUT_ENABLED=1|up -d|restart api|restart worker/);
    expect(code).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/); // no address in a public repo
  });
});
