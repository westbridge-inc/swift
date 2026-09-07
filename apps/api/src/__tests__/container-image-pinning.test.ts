import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [SUP-001 · SUP-002 · CONT-001] AN UNPINNED IMAGE IS A DIFFERENT PROGRAM
// TOMORROW.
//
// Codex REPORT-075: every runtime image was referenced by a MUTABLE tag, and
// one — Photon — by `latest` from an individual's account. A tag is a pointer
// its publisher can move at any time, so `docker compose pull` could hand a
// production host different software than the one that was tested, with no diff
// and no signal. That is a supply-chain exposure, not a tidiness issue.
//
// Digests are content addresses: `postgis:16-3.4@sha256:44126d...` resolves to
// exactly those bytes or fails. The tag is kept alongside it so a human can
// still read which version it is.
//
// This test is the ratchet. Adding a service without a digest fails here rather
// than in six months on a host nobody remembers provisioning.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '..', '..', '..', '..');
const COMPOSE = [
  'deploy/docker-compose.yml',
  'deploy/docker-compose.routing.yml',
  'infrastructure/docker/docker-compose.yml',
];

/** Built here from a Dockerfile, not pulled — a digest would be meaningless. */
const LOCALLY_BUILT = /^(swift-api|swift-superset)([:@]|$)/;

const imageLines = (file: string): Array<{ line: number; image: string }> => {
  const out: Array<{ line: number; image: string }> = [];
  readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((text, i) => {
    const m = /^\s*image:\s*(\S+)/.exec(text);
    if (m) out.push({ line: i + 1, image: m[1]! });
  });
  return out;
};

describe('[SUP-001] every third-party container image is pinned to a digest', () => {
  it('the compose files this repository ships exist and declare images', () => {
    for (const f of COMPOSE) expect(existsSync(join(ROOT, f)), f).toBe(true);
    expect(COMPOSE.flatMap(imageLines).length).toBeGreaterThan(5);
  });

  it('no image is referenced by a mutable tag alone', () => {
    const unpinned: string[] = [];
    for (const file of COMPOSE) {
      for (const { line, image } of imageLines(file)) {
        if (LOCALLY_BUILT.test(image)) continue;
        if (!image.includes('@sha256:')) unpinned.push(`${file}:${line} ${image}`);
      }
    }
    expect(unpinned, 'pin with `repo:tag@sha256:...` — `docker buildx imagetools inspect <ref>` prints the digest').toEqual([]);
  });

  it('nothing is pulled from `latest`, digest or not', () => {
    // A digest-pinned `latest` is reproducible but still says nothing about
    // WHICH release it is, which is the other half of SUP-002.
    const latest: string[] = [];
    for (const file of COMPOSE) {
      for (const { line, image } of imageLines(file)) {
        if (LOCALLY_BUILT.test(image)) continue;
        if (/:latest(@|$)/.test(image)) latest.push(`${file}:${line} ${image}`);
      }
    }
    expect(latest, 'a `latest` tag names no version; use the release tag its publisher assigns').toEqual([]);
  });

  it('a digest is a real sha256, not a placeholder somebody typed', () => {
    const bad: string[] = [];
    for (const file of COMPOSE) {
      for (const { line, image } of imageLines(file)) {
        const at = image.indexOf('@');
        if (at === -1) continue;
        if (!/^@sha256:[0-9a-f]{64}$/.test(image.slice(at))) bad.push(`${file}:${line} ${image}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
