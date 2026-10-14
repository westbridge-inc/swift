/**
 * [S3-L1] A process starts only on a database of its own kind: the API and
 * the worker read the database's deployment_identity before anything is
 * served or any job runs (utils/deployment-identity.ts). A production process
 * starts only on a database that says `production`; any other mode refuses a
 * database that says `production`.
 *
 * No database needed: the rule is exercised through a stand-in client, and
 * the two entry points are read as text (the repo's convention for boot
 * wiring: building or starting them here would start a server and workers).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDeploymentIdentityMatchesMode,
  checkDeploymentIdentityAtStart,
  DeploymentIdentityRefused,
  type IdentityDb,
} from '../utils/deployment-identity';
import { RuntimeModeError } from '../utils/runtime-mode';

type Answer = { environment: string } | null | Error;
function db(answer: Answer) {
  const findUnique = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const $disconnect = vi.fn(async () => undefined);
  // The stand-in answers the one call the rule makes; typed as the client.
  const client = { deploymentIdentity: { findUnique }, $disconnect } as unknown as IdentityDb & { $disconnect(): Promise<void> };
  return { client, findUnique, $disconnect };
}
const prismaError = (code: string) => Object.assign(new Error(`prisma ${code}`), { code });
const SECRET_URL = 'postgresql://swift_app:do-not-print-me@db.internal:5432/swift';
const envOf = (NODE_ENV: string | undefined) => ({ NODE_ENV, DATABASE_URL: SECRET_URL });

async function refusal(answer: Answer, mode: string): Promise<Error> {
  const err = await assertDeploymentIdentityMatchesMode(db(answer).client, envOf(mode)).then(() => null, (e: unknown) => e as Error);
  expect(err, `${mode} on ${JSON.stringify(answer instanceof Error ? (answer as { code?: string }).code : answer)} must refuse`).toBeInstanceOf(DeploymentIdentityRefused);
  expect(err!.message).toMatch(/^FATAL: /);
  expect(err!.message).not.toContain('do-not-print-me');
  expect(err!.message).not.toContain('db.internal');
  return err!;
}

describe('[S3-L1] production starts only on a database that says production', () => {
  it('a production database: starts, reading only the singleton row', async () => {
    const d = db({ environment: 'production' });
    await expect(assertDeploymentIdentityMatchesMode(d.client, envOf('production'))).resolves.toBeUndefined();
    expect(d.findUnique).toHaveBeenCalledWith({ where: { id: 'singleton' }, select: { environment: true } });
  });

  it.each(['staging', 'development', 'test', 'Production', 'production ', ''])('a database that says %j: refused', async (word) => {
    const err = await refusal({ environment: word }, 'production');
    expect(err.message).toContain(`deployment_identity says ${JSON.stringify(word)}`);
  });

  it('a database without the row: refused, and told where the row is written', async () => {
    const err = await refusal(null, 'production');
    expect(err.message).toContain('has no deployment_identity row');
    expect(err.message).toContain('PILOT-RUNBOOK section 12');
  });

  it.each(['P2021', 'P1001', 'P2010'])('an unreadable identity (%s, the table missing included): refused', async (code) => {
    const err = await refusal(prismaError(code), 'production');
    expect(err.message).toContain(`could not be read (${code})`);
  });

  it('an error without a code: refused', async () => {
    const err = await refusal(new Error('socket hang up'), 'production');
    expect(err.message).toContain('could not be read (read failed)');
  });
});

describe('[S3-L1] any other mode refuses the production database', () => {
  it.each(['development', 'test', 'loadtest'])('NODE_ENV=%s on a database that says production: refused, naming both', async (mode) => {
    const err = await refusal({ environment: 'production' }, mode);
    expect(err.message).toContain(`NODE_ENV=${mode}, but this database's deployment_identity says "production"`);
    expect(err.message).toContain('NODE_ENV=production, PILOT_ENV=production');
  });

  it.each([
    [{ environment: 'staging' }],
    [{ environment: 'development' }],
    [{ environment: 'test' }],
    [null],
  ] as Answer[][])('NODE_ENV=development on %j: starts', async (answer) => {
    await expect(assertDeploymentIdentityMatchesMode(db(answer).client, envOf('development'))).resolves.toBeUndefined();
  });

  it('a schema without the table (P2021) starts outside production', async () => {
    for (const mode of ['development', 'test', 'loadtest']) {
      await expect(assertDeploymentIdentityMatchesMode(db(prismaError('P2021')).client, envOf(mode))).resolves.toBeUndefined();
    }
  });

  it('any other read failure refuses outside production too: it cannot know it is not the production database', async () => {
    const err = await refusal(prismaError('P1001'), 'development');
    expect(err.message).toContain('could not be read (P1001)');
  });

  it('an unset or misspelled NODE_ENV throws before the database is read', async () => {
    for (const mode of [undefined, 'prod', 'staging']) {
      const d = db({ environment: 'production' });
      await expect(assertDeploymentIdentityMatchesMode(d.client, envOf(mode))).rejects.toBeInstanceOf(RuntimeModeError);
      expect(d.findUnique).not.toHaveBeenCalled();
    }
  });
});

describe('[S3-L1] the API start check closes its own client', () => {
  it('on a pass and on a refusal', async () => {
    const ok = db({ environment: 'production' });
    await expect(checkDeploymentIdentityAtStart(() => ok.client, envOf('production'))).resolves.toBeUndefined();
    expect(ok.$disconnect).toHaveBeenCalledTimes(1);
    const bad = db({ environment: 'production' });
    await expect(checkDeploymentIdentityAtStart(() => bad.client, envOf('development'))).rejects.toBeInstanceOf(DeploymentIdentityRefused);
    expect(bad.$disconnect).toHaveBeenCalledTimes(1);
  });
});

// The entry points, as text: the API checks after the boot-config guard and
// BEFORE building the app (building it starts the in-process job workers);
// the worker checks before its job runtime starts. A refusal is not caught
// on the way: each entry's own failure path exits 1.
const SRC = join(__dirname, '..');
const code = (file: string) => readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('[S3-L1] both entry points run the check before anything is served or run', () => {
  it('server.ts: after assertSafeBootConfig, before buildApp, awaited, inside the start try', () => {
    const s = code('server.ts');
    const start = s.indexOf('async function start()');
    const guard = s.indexOf('assertSafeBootConfig();', start);
    const check = s.indexOf('await checkDeploymentIdentityAtStart();', start);
    const build = s.indexOf('await buildApp()', start);
    const failure = s.indexOf("console.error('Failed to start server:', err);", start);
    expect(start).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(start);
    expect(check).toBeGreaterThan(guard);
    expect(build).toBeGreaterThan(check);
    expect(failure).toBeGreaterThan(build);
    expect(s.match(/checkDeploymentIdentityAtStart\(/g)).toHaveLength(1);
    expect(s).toMatch(/import \{ checkDeploymentIdentityAtStart \} from '\.\/utils\/deployment-identity';/);
  });

  it('worker.ts: on its own client, before the job runtime starts, awaited, failure exits', () => {
    const w = code('worker.ts');
    const main = w.indexOf('async function main()');
    const client = w.indexOf('const prisma = new PrismaClient(', main);
    const check = w.indexOf('await assertDeploymentIdentityMatchesMode(prisma);', main);
    const runtime = w.indexOf('initializeJobRuntime(', main);
    expect(main).toBeGreaterThan(-1);
    expect(client).toBeGreaterThan(main);
    expect(check).toBeGreaterThan(client);
    expect(runtime).toBeGreaterThan(check);
    expect(w.match(/assertDeploymentIdentityMatchesMode\(/g)).toHaveLength(1);
    expect(w).toMatch(/main\(\)\.catch\(\(err\) => \{\s*console\.error\('Worker failed to start:', err\);\s*process\.exit\(1\);/);
  });
});
