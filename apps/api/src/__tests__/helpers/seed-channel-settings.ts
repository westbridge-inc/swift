import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getChannels } from '../../providers/notifications/channels';
import { SECRET_FILE_NAMES } from '../../utils/secret-files';

/**
 * [SEED-FIX 27 Oct] What the seed container's notification channels see.
 *
 * The owner's solo re-seed was refused at its start in production: the seed
 * container (deploy/docker-compose.seed.yml) had the email and text settings
 * but not PUSH_PROVIDER, and getChannels() builds EVERY channel, so the push
 * refusal (dev push in production) stopped an email. Nothing in the tests ran
 * the channels in production posture with only what the compose file passes.
 * These helpers do, and they take the list of settings from the CODE (every
 * name getChannels() reads while it builds the channels in production), never
 * from a hand-typed copy.
 */

/**
 * The production channels, with placeholder values only. boot-config.ts lets
 * production run on exactly these providers (twilio, expo, smtp). The secrets
 * are given here as their values, the way the secret-file loader hands them
 * to the process after it reads NAME_FILE.
 */
export const PRODUCTION_CHANNELS: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  NOTIFICATION_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'placeholder-not-a-secret',
  TWILIO_FROM: '+15005550006',
  PUSH_PROVIDER: 'expo',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.invalid',
  SMTP_PORT: '465',
  SMTP_USER: 'swift@example.invalid',
  SMTP_PASS: 'placeholder-not-a-secret',
  EMAIL_FROM: 'Swift <swift@example.invalid>',
};

/**
 * Every environment name getChannels() reads while it builds the channels in
 * production, recorded through a proxy over process.env. The proxy holds only
 * PRODUCTION_CHANNELS, so this also proves those values build every channel
 * (a new required setting makes getChannels() throw here, loudly).
 */
export function channelSettingsReadInProduction(): string[] {
  const saved = process.env;
  const read = new Set<string>();
  const env: Record<string, string | undefined> = { ...PRODUCTION_CHANNELS };
  process.env = new Proxy(env, {
    get: (target, key) => {
      if (typeof key === 'string') read.add(key);
      return target[key as string];
    },
    has: (target, key) => {
      if (typeof key === 'string') read.add(key);
      return key in target;
    },
  }) as typeof process.env;
  try {
    getChannels();
  } finally {
    process.env = saved;
  }
  return [...read].sort();
}

/** A secret reaches a process only as NAME_FILE (utils/secret-files.ts). */
export const isSecretSetting = (name: string): boolean => (SECRET_FILE_NAMES as readonly string[]).includes(name);

export const SEED_COMPOSE = join(process.cwd(), '../../deploy/docker-compose.seed.yml');

/** The seed service's `environment:` block, name -> the value as written in the compose file. */
export function seedContainerEnvironment(text: string = readFileSync(SEED_COMPOSE, 'utf8')): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.indexOf('    environment:');
  if (start < 0) throw new Error('docker-compose.seed.yml has no environment block for the seed service');
  const out = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,4}\S/.test(line)) break; // the service's next key (volumes:)
    const m = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/**
 * Every name the seed container's process holds once it runs: its compose
 * environment, each secret's NAME_FILE as the NAME the secret-file loader turns
 * it into, and DATABASE_URL, which the loader assembles from the POSTGRES_*
 * parts (dist/boot/secret-files.js runs before the seed; see the compose file).
 */
export function seedContainerNames(compose: Map<string, string> = seedContainerEnvironment()): Set<string> {
  const names = new Set<string>(['DATABASE_URL']);
  for (const key of compose.keys()) {
    const secret = key.endsWith('_FILE') ? key.slice(0, -'_FILE'.length) : null;
    names.add(secret !== null && isSecretSetting(secret) ? secret : key);
  }
  return names;
}

/**
 * The test runner's own settings. No deployed process has them; the recording
 * lets them through so the runner's database lock keeps working, and never
 * counts them as settings the seed needs.
 */
export const isTestRunnerSetting = (name: string): boolean => /^VITEST/.test(name) || /^TEST_TARGET_/.test(name);

/**
 * [SEED-FIX census] The names a solo re-seed reads, in the seed container, that
 * the container does not hold on purpose, each with why its unset value is the
 * right one there. seed-solo-reseed.test.ts records every name the start (A7f)
 * and the apply (A7g) read and fails on any other one, so a new setting on that
 * path is either passed by docker-compose.seed.yml or reviewed onto this list.
 */
export const UNSET_IN_THE_SEED: Readonly<Record<string, string>> = {
  TENANT_RLS_BIND:
    'The seed connects as the stack login that owns the schema, outside the tenant wall. Unset, the review seal delivers when its lookup fails, so the owner never loses a notice about their own production settings.',
  RUN_WORKERS: 'The connection pool sizes itself for one combined process: the seed is one short-lived process.',
  DB_POOL_SIZE_COMBINED: 'The default pool size (db-pool.ts) for that one process.',
  DB_POOL_TIMEOUT_SECONDS: 'The default pool wait (db-pool.ts).',
  '*': 'Prisma copies the environment for its query engine when a client is built; it reads no setting of ours.',
  PRISMA_CLIENT_ENGINE_TYPE: "Prisma's own engine setting: its default.",
  PRISMA_CLIENT_GET_TIME: "Prisma's own engine setting: its default.",
  PRISMA_QUERY_ENGINE_BINARY: "Prisma's own engine setting: its default.",
  PRISMA_QUERY_ENGINE_LIBRARY: "Prisma's own engine setting: its default.",
  UNDICI_NO_FG: "Node's built-in fetch (undici) reads it when it loads: its default.",
  JEST_WORKER_ID: "Node's built-in fetch (undici) looks for a test runner when it loads: none in a container.",
  NODE_V8_COVERAGE: "Node's own coverage switch: off in a container.",
};
