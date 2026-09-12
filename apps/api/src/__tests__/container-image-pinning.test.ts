import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [SUP-001 · SUP-002 · CONT-001] AN UNPINNED IMAGE IS A DIFFERENT PROGRAM
// TOMORROW.
//
// Codex REPORT-075: every runtime image was referenced by a MUTABLE tag, one by
// `latest` from an individual's account. A tag is a pointer its publisher can
// move, so `docker compose pull` can hand a production host different software
// than the one that was tested, with no diff and no signal.
//
// WHY THIS FILE WAS REWRITTEN. The first version hard-coded three compose files
// and called itself "every container image". A census found NINE files naming
// an image and TEN unpinned references it never read — more than the ten it
// pinned. The worst was the exemption: `apps/api/Dockerfile`'s
// `FROM node:20-slim` was excused because the image is "built here, not pulled,
// so a digest would be meaningless". That is backwards — a locally built image
// inherits every bit of its base image's mutability, and `node:20-slim` is
// re-pushed roughly weekly. The one image that actually runs Swift's production
// code was the one thing the gate excused.
//
// So the gate now DISCOVERS. Files are enrolled with an expected count, and a
// file that names an image without being enrolled fails the build. A gate whose
// coverage is a hard-coded list is a gate that silently shrinks.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '..', '..', '..', '..');

/**
 * Every file that names a container image, with how many references it holds.
 * The count is the ratchet: a file quietly dropping to zero references (a
 * reformat, a rename, a bad merge) is a coverage loss, and a repo-wide total
 * cannot see it.
 */
// Dockerfile counts include intra-file stage references (`FROM base AS deps`);
// the pin check filters those, but the COUNT must see every FROM line so a
// deleted stage or a new base image cannot slip in unnoticed.
const ENROLLED: Record<string, number> = {
  'deploy/docker-compose.yml': 6,
  'deploy/docker-compose.routing.yml': 4,
  'infrastructure/docker/docker-compose.yml': 3,
  'tools/analytics/docker-compose.yml': 1,
  '.github/workflows/ci.yml': 3,
  'apps/api/Dockerfile': 4,
  'infrastructure/docker/Dockerfile.api': 4,
  'infrastructure/docker/Dockerfile.admin': 4,
  'tools/analytics/Dockerfile': 1,
  'deploy/setup-routing.sh': 1,
};

/** Directories a source census must never walk into. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.expo', 'ios', 'android']);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

/** Files that can carry an image reference at all. */
const isImageBearing = (rel: string) =>
  /(^|\/)docker-compose[^/]*\.ya?ml$/.test(rel) ||
  /(^|\/)Dockerfile[^/]*$/.test(rel) ||
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel) ||
  /^deploy\/[^/]+\.sh$/.test(rel);

interface Ref { line: number; image: string }

/**
 * Image references in one file. Handles what the previous parser did not:
 * flow-style mappings (`svc: { image: x }`), quoted values, YAML anchors,
 * Dockerfile `FROM`, and a shell `IMAGE=` assignment.
 */
function imageRefs(rel: string, text: string): Ref[] {
  const out: Ref[] = [];
  const push = (line: number, raw: string) => {
    const image = raw.trim().replace(/^['"]|['"],?$/g, '').replace(/[,}]+$/, '');
    if (image) out.push({ line, image });
  };
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\s*#/.test(line)) return; // a commented-out image is not an image
    if (/Dockerfile/.test(rel)) {
      // Multi-stage names are not images: `FROM base AS deps` refers to a stage
      // declared in this same file.
      const m = /^\s*FROM\s+(\S+)/i.exec(line);
      if (m) push(i + 1, m[1]!);
      return;
    }
    if (rel.endsWith('.sh')) {
      const m = /^\s*[A-Z_]*IMAGE[A-Z_]*=(\S+)/.exec(line);
      if (m) push(i + 1, m[1]!);
      return;
    }
    // YAML: block style anywhere on the line, and flow style inside `{ ... }`.
    for (const m of line.matchAll(/(?:^|[\s{,])image:\s*([^,}\n]+)/g)) push(i + 1, m[1]!);
  });
  return out;
}

/** A `FROM <stage>` naming an earlier stage in the same Dockerfile. */
const stageNames = (text: string) =>
  new Set([...text.matchAll(/^\s*FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]!.toLowerCase()));

/** BuildKit frontend directives are not runtime images. */
const isSyntaxDirective = (rel: string, line: number, text: string) =>
  /Dockerfile/.test(rel) && /^\s*#\s*syntax=/.test(text.split('\n')[line - 2] ?? '');

/**
 * Images this repository BUILDS. Keyed off the service carrying a `build:`
 * stanza, not off the image NAME — `image: swift-api:latest` on an arbitrary
 * new service used to be waved through by a name match.
 */
function locallyBuilt(rel: string, text: string): Set<string> {
  const built = new Set<string>();
  if (!/docker-compose/.test(rel)) return built;
  // A service block is `  name:` at two spaces; collect those containing `build:`.
  const lines = text.split('\n');
  let block: string[] = [];
  const flush = () => {
    if (block.some((l) => /^\s{4,}build:/.test(l))) {
      for (const l of block) {
        const m = /^\s*image:\s*(\S+)/.exec(l);
        if (m) built.add(m[1]!.replace(/^['"]|['"]$/g, '').split(/[:@]/)[0]!);
      }
    }
    block = [];
  };
  for (const l of lines) {
    if (/^\s{2}\S+:\s*$/.test(l)) flush();
    block.push(l);
  }
  flush();
  return built;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const nameOf = (image: string) => image.split(/[:@]/)[0]!;

describe('[SUP-001] every third-party container image is pinned to a digest', () => {
  it('every enrolled file exists and holds exactly the references it is enrolled for', () => {
    const wrong: string[] = [];
    for (const [rel, expected] of Object.entries(ENROLLED)) {
      if (!existsSync(join(ROOT, rel))) { wrong.push(`${rel}: MISSING`); continue; }
      const found = imageRefs(rel, read(rel)).length;
      if (found !== expected) wrong.push(`${rel}: enrolled for ${expected}, found ${found}`);
    }
    expect(
      wrong,
      'a file that silently stops contributing references is a coverage loss no repo-wide total can see',
    ).toEqual([]);
  });

  it('no file names an image without being enrolled — the gate cannot silently shrink', () => {
    const unenrolled = walk(ROOT)
      .map((f) => relative(ROOT, f).split('\\').join('/'))
      .filter((rel) => isImageBearing(rel) && !(rel in ENROLLED))
      .filter((rel) => imageRefs(rel, read(rel)).length > 0);
    expect(
      unenrolled,
      'these files name a container image and no test reads them — add them to ENROLLED with their count',
    ).toEqual([]);
  });

  it('no image is referenced by a mutable tag alone', () => {
    const unpinned: string[] = [];
    for (const rel of Object.keys(ENROLLED)) {
      const text = read(rel);
      const stages = stageNames(text);
      const built = locallyBuilt(rel, text);
      for (const { line, image } of imageRefs(rel, text)) {
        if (stages.has(image.toLowerCase())) continue;            // FROM <earlier stage>
        if (isSyntaxDirective(rel, line, text)) continue;
        if (built.has(nameOf(image))) continue;                   // built here, by build: stanza
        if (/\$\{/.test(image)) continue;                         // variable tag on a built image
        if (!image.includes('@sha256:')) unpinned.push(`${rel}:${line} ${image}`);
      }
    }
    expect(unpinned, 'pin with `repo:tag@sha256:...` — `docker buildx imagetools inspect <ref>` prints the digest').toEqual([]);
  });

  it('nothing is pulled from `latest`, digest or not', () => {
    const latest: string[] = [];
    for (const rel of Object.keys(ENROLLED)) {
      const text = read(rel);
      const built = locallyBuilt(rel, text);
      for (const { line, image } of imageRefs(rel, text)) {
        if (built.has(nameOf(image))) continue;
        if (/:latest(@|$)/.test(image)) latest.push(`${rel}:${line} ${image}`);
      }
    }
    expect(latest, 'a `latest` tag names no version; use the release tag its publisher assigns').toEqual([]);
  });

  it('a digest is a real sha256, not a placeholder somebody typed', () => {
    const bad: string[] = [];
    for (const rel of Object.keys(ENROLLED)) {
      for (const { line, image } of imageRefs(rel, read(rel))) {
        const at = image.indexOf('@');
        if (at === -1) continue;
        if (!/^@sha256:[0-9a-f]{64}$/.test(image.slice(at))) bad.push(`${rel}:${line} ${image}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('one tag never resolves to two different digests across the repository', () => {
    // Nothing binds a digest to the image beside it — a syntax check cannot.
    // What it CAN do is catch the copy-paste: the same `repo:tag` pinned to two
    // different digests in two files means at least one of them is wrong.
    const seen = new Map<string, { digest: string; at: string }>();
    const conflicts: string[] = [];
    for (const rel of Object.keys(ENROLLED)) {
      for (const { line, image } of imageRefs(rel, read(rel))) {
        const at = image.indexOf('@');
        if (at === -1) continue;
        const ref = image.slice(0, at);
        const digest = image.slice(at + 1);
        const prev = seen.get(ref);
        if (prev && prev.digest !== digest) conflicts.push(`${ref}: ${prev.digest} at ${prev.at}, ${digest} at ${rel}:${line}`);
        else if (!prev) seen.set(ref, { digest, at: `${rel}:${line}` });
      }
    }
    expect(conflicts, 'the same tag pinned to two digests — at least one is wrong').toEqual([]);
    expect(seen.size, 'the census resolved no pinned references at all').toBeGreaterThan(4);
  });

  it('CI and deploy run the SAME pinned bytes — pinning one and not the other creates the drift', () => {
    // Before this, CI and deploy both said `postgis:16-3.4` and drifted together.
    // Pinning only deploy would freeze production while CI floated — guaranteeing,
    // permanently and invisibly, the divergence this file exists to prevent.
    const digestsIn = (rel: string) => {
      const m = new Map<string, string>();
      for (const { image } of imageRefs(rel, read(rel))) {
        const at = image.indexOf('@');
        if (at !== -1) m.set(image.slice(0, at), image.slice(at + 1));
      }
      return m;
    };
    const ci = digestsIn('.github/workflows/ci.yml');
    const deploy = digestsIn('deploy/docker-compose.yml');
    const shared = [...ci.keys()].filter((k) => deploy.has(k));
    expect(shared.length, 'CI and deploy share no pinned image — the comparison below is vacuous').toBeGreaterThan(0);
    for (const ref of shared) expect(ci.get(ref), `${ref} differs between CI and deploy`).toBe(deploy.get(ref));
  });

  it('a digest-pinned repo has a re-pin path, or the CVE fix never arrives', () => {
    // Pinning converts "the tag silently picks up the base-OS fix" into "the fix
    // never arrives". That trade is only acceptable with something scheduled to
    // re-resolve them.
    const dependabot = read('.github/dependabot.yml');
    expect(dependabot, 'no `docker` ecosystem: nothing will ever open a PR to move these digests').toContain('package-ecosystem: "docker"');
    for (const dir of ['/deploy', '/infrastructure/docker', '/apps/api', '/tools/analytics']) {
      expect(dependabot, `${dir} holds pinned images and is not watched`).toContain(`directory: "${dir}"`);
    }
  });
});
