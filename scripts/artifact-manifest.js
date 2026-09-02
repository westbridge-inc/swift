#!/usr/bin/env node
/**
 * Artifact manifest [SCR-006]: what a build IS, so a scan can prove it scanned
 * THAT build. Emitted right after each build in CI and handed to
 * public-secrets-gate.js --bundle <dir> --manifest <file>.
 *
 *   node scripts/artifact-manifest.js <built-dir> --app <name> --commit <sha> \
 *        --entry <relative path> [--entry ...] --out <manifest.json>
 *
 * The manifest names the app, the commit, the toolchain, every file with its
 * SHA-256 and size, the entrypoints that must exist and be non-empty, and the
 * whole tree's digest. Symlinks are recorded and never followed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const positional = [];
const opt = { entry: [] };
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--app' || args[i] === '--commit' || args[i] === '--out') { opt[args[i].slice(2)] = args[i + 1]; i += 1; }
  else if (args[i] === '--entry') { opt.entry.push(args[i + 1]); i += 1; }
  else positional.push(args[i]);
}
const dir = positional[0] ? path.resolve(positional[0]) : null;
if (!dir || !opt.app || !opt.commit || !opt.out) {
  console.error('usage: artifact-manifest.js <built-dir> --app <name> --commit <sha> [--entry <path>]... --out <file>');
  process.exit(2);
}

function walk(root, rel = '', out = []) {
  const entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) { out.push({ path: r, symlink: fs.readlinkSync(path.join(root, r)) }); continue; }
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push({ path: r });
  }
  return out;
}
const files = [];
for (const f of walk(dir)) {
  if (f.symlink !== undefined) { files.push({ path: f.path, symlink: f.symlink }); continue; }
  let buf;
  try { buf = fs.readFileSync(path.join(dir, f.path)); } catch (e) { files.push({ path: f.path, unreadable: e.code || 'EIO' }); continue; }
  files.push({ path: f.path, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
}
files.sort((a, b) => (a.path < b.path ? -1 : 1));
const treeDigest = crypto.createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256 ?? (f.symlink !== undefined ? 'symlink:' + f.symlink : 'unreadable')}`).join('\n')).digest('hex');
const manifest = {
  version: 1, app: opt.app, commit: opt.commit, toolchain: { node: process.version },
  generatedAt: new Date().toISOString(), root: path.basename(dir), entrypoints: opt.entry,
  fileCount: files.filter((f) => f.sha256).length, byteCount: files.reduce((n, f) => n + (f.bytes || 0), 0), treeDigest, files,
};
fs.writeFileSync(opt.out, JSON.stringify(manifest, null, 2));
console.log(`artifact manifest: ${manifest.app} @ ${manifest.commit} — ${manifest.fileCount} file(s), ${manifest.byteCount} byte(s), tree ${treeDigest.slice(0, 12)}… → ${opt.out}`);
