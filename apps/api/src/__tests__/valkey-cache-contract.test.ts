import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [LIC-001 · Codex REPORT-075] The cache is Valkey, and the old volume is the
// rollback.
//
// `redis:7-alpine` resolves to Redis 7.4.7, offered under RSALv2 or SSPLv1 —
// neither OSI-approved. Valkey is the Linux Foundation fork of Redis 7.2,
// BSD-3-Clause.
//
// The half that is easy to undo by accident is not the image line. It is the
// volume. Valkey 8 CANNOT read a Redis 7.4 AOF/RDB (format v12): it logs
// "Can't handle RDB format version 12" and exits 1. So:
//
//   • pointing Valkey at `swift-redisdata` crash-loops it, fails the API's
//     startup PING, and takes the platform down — not degrades it, down; and
//   • deleting `swift-redisdata` destroys the only rollback, because there is
//     no binary path back either (DUMP/RESTORE and MIGRATE fail the same way).
//
// A tidy-up commit that removes an "unused" volume is exactly how that
// happens, so the volume's continued existence is asserted here rather than
// left to a comment nobody reads.
//
// Procedure and evidence: deploy/VALKEY-MIGRATION.md
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

const DEPLOY = read('deploy/docker-compose.yml');
const DEV = read('infrastructure/docker/docker-compose.yml');
const RUNBOOK = read('deploy/VALKEY-MIGRATION.md');
const PREFLIGHT = read('deploy/valkey-preflight.mjs');

const COMPOSES: Array<[string, string]> = [['deploy', DEPLOY], ['development', DEV]];

describe('[LIC-001] the cache is Valkey everywhere', () => {
  it('both compose files were found', () => {
    expect(DEPLOY.length, 'deploy/docker-compose.yml is missing').toBeGreaterThan(500);
    expect(DEV.length, 'infrastructure/docker/docker-compose.yml is missing').toBeGreaterThan(500);
  });

  it.each(COMPOSES)('%s runs a valkey image, and no redis image at all', (_label, compose) => {
    const images = [...compose.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(images.some((i) => i.startsWith('valkey/valkey:')), 'no valkey image').toBe(true);
    // `redis:` as an image, not as the word in a URL or a comment.
    expect(images.filter((i) => /^redis:/.test(i)), 'a Redis image is still declared').toEqual([]);
  });

  it.each(COMPOSES)('%s starts valkey-server, not the redis-server compat shim', (_label, compose) => {
    // The image ships redis-server as a symlink to valkey-server, so calling it
    // WOULD work — and would leave a file that reads as if it still ran Redis.
    expect(compose).toContain('valkey-server');
    expect(compose).not.toMatch(/['"]redis-server['"]/);
  });

  it.each(COMPOSES)('%s keeps the pre-migration volume declared — it is the rollback', (_label, compose) => {
    const volumesBlock = compose.slice(compose.lastIndexOf('\nvolumes:'));
    expect(volumesBlock, 'volumes: block not found').toContain('volumes:');
    expect(volumesBlock, 'the valkey volume is not declared').toMatch(/^\s+(swift-)?valkeydata:/m);
    expect(
      volumesBlock,
      'the pre-migration cache volume was removed — that deletes the ONLY rollback, ' +
      'because Valkey cannot read it and there is no binary path back either',
    ).toMatch(/^\s+(swift-)?redisdata:/m);
  });

  it('no service mounts the old volume — declared for rollback, never read', () => {
    for (const [label, compose] of COMPOSES) {
      const mounts = [...compose.matchAll(/^\s+-\s+((?:swift-)?redisdata):\/data/gm)];
      expect(mounts.map((m) => m[1]), `${label} still mounts the pre-migration volume`).toEqual([]);
    }
  });

  it('the API is pointed at the valkey service, and REDIS_URL keeps its name', () => {
    // redis:// is the wire protocol and the client is still ioredis; renaming
    // the variable would touch 200+ call sites to say the same thing.
    const urls = [...DEPLOY.matchAll(/REDIS_URL:\s*(\S+)/g)].map((m) => m[1]!);
    expect(urls.length, 'no REDIS_URL wired in the deploy compose').toBeGreaterThan(0);
    for (const u of urls) expect(u).toBe('redis://valkey:6379');
  });

  it('every depends_on names the valkey service', () => {
    expect(DEPLOY).not.toMatch(/^\s+redis:\n\s+condition:/m);
    expect(DEPLOY).toMatch(/^\s+valkey:\n\s+condition:\s*service_healthy/m);
  });
});

describe('[LIC-001] the cutover cannot be run blind', () => {
  it('the runbook and the preflight both exist', () => {
    expect(RUNBOOK.length, 'deploy/VALKEY-MIGRATION.md is missing').toBeGreaterThan(2000);
    expect(PREFLIGHT.length, 'deploy/valkey-preflight.mjs is missing').toBeGreaterThan(1000);
  });

  it('the compose points a reader at the runbook before they cut over', () => {
    expect(DEPLOY).toContain('deploy/VALKEY-MIGRATION.md');
  });

  it('the preflight has no imports that a bare production host would lack', () => {
    // It runs on the machine that most needs checking, which is the one with
    // nothing installed. A missing module would crash it — and a crash exits
    // non-zero, which reads exactly like a real finding.
    const imports = [...PREFLIGHT.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec, `${spec} is not a Node builtin`).toMatch(/^node:/);
  });

  it('the runbook states the three exit codes, including that a failed check is not a GO', () => {
    expect(RUNBOOK).toMatch(/\*\*0\*\*\s*\|\s*GO/);
    expect(RUNBOOK).toMatch(/\*\*1\*\*\s*\|\s*WAIT/);
    expect(RUNBOOK).toMatch(/\*\*2\*\*.*not a GO/s);
  });
});
