#!/usr/bin/env node
// [CI-SPLIT] The API suite runs as N shard jobs (vitest --shard=i/N), each on
// its own Postgres and Redis. Splitting a suite is only safe if nothing falls
// between the shards: a file that no shard ran is a test that silently stopped
// gating merges, and a file that two shards ran means the split is not the
// split we think it is. This proves the partition from what actually RAN.
//
//   node scripts/ci-api-shard-partition.mjs --root <apps/api> \
//     --expected <vitest list --filesOnly --json output> \
//     --junit-dir <dir holding junit-1.xml … junit-N.xml> --count N
//
// --expected is the suite's own file list (the config's include pattern, as
// vitest resolves it). Each junit-i.xml is shard i's JUnit report: one
// <testsuite name="src/…test.ts"> per file that shard ran (a file that failed
// to import or whose tests were all skipped still gets one). Exit 0 only when
// every expected file ran in exactly one shard, no shard ran a file outside
// the list, and every shard 1…N reported. Dependency-free on purpose.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

function usage(message) {
  console.error(`ci-api-shard-partition: ${message}`);
  console.error('usage: --root <dir> --expected <file> --junit-dir <dir> --count <N>');
  process.exit(2);
}

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!key?.startsWith('--') || value === undefined) usage(`bad argument near "${key ?? ''}"`);
  opt[key.slice(2)] = value;
}
for (const key of ['root', 'expected', 'junit-dir', 'count']) if (!opt[key]) usage(`--${key} is required`);
const count = Number(opt.count);
if (!Number.isInteger(count) || count < 1) usage(`--count must be a positive integer, got "${opt.count}"`);

const toPosix = (p) => p.split(sep).join('/');
const unescapeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const problems = [];

// The expected list: vitest prints absolute paths; compare relative to the suite root.
let expectedRaw;
try {
  expectedRaw = JSON.parse(readFileSync(opt.expected, 'utf8'));
} catch (error) {
  usage(`cannot read the expected file list ${opt.expected}: ${error.message}`);
}
if (!Array.isArray(expectedRaw)) usage('the expected file list is not a JSON array');
const expected = new Set();
for (const entry of expectedRaw) {
  const file = typeof entry === 'string' ? entry : entry?.file;
  if (typeof file !== 'string' || !isAbsolute(file)) usage(`unexpected entry in the expected list: ${JSON.stringify(entry)}`);
  const rel = toPosix(relative(opt.root, file));
  if (rel.startsWith('../')) usage(`expected file ${file} is outside --root ${opt.root}`);
  expected.add(rel);
}
// A partition of nothing is trivially exact; refuse to certify it.
if (expected.size === 0) problems.push('the expected file list is empty: vitest found no API test files, so there is nothing to prove');

// What each shard ran.
const junitDir = opt['junit-dir'];
if (!existsSync(junitDir)) usage(`--junit-dir ${junitDir} does not exist`);
const present = readdirSync(junitDir).filter((name) => /^junit-\d+\.xml$/.test(name));
for (const name of present) {
  const index = Number(name.match(/^junit-(\d+)\.xml$/)[1]);
  if (index < 1 || index > count) problems.push(`${name} is not one of the ${count} shards: a shard ran outside the configured split`);
}

const ranBy = new Map(); // file -> [shard indexes]
const perShard = [];
for (let index = 1; index <= count; index += 1) {
  const file = join(junitDir, `junit-${index}.xml`);
  if (!existsSync(file)) {
    problems.push(`shard ${index} of ${count} left no report (junit-${index}.xml): its files cannot be shown to have run`);
    perShard.push(0);
    continue;
  }
  const xml = readFileSync(file, 'utf8');
  const names = [...xml.matchAll(/<testsuite\s+name="([^"]*)"/g)].map((m) => toPosix(unescapeXml(m[1])));
  perShard.push(names.length);
  for (const name of names) {
    const shards = ranBy.get(name) ?? [];
    shards.push(index);
    ranBy.set(name, shards);
  }
}

const list = (items) => items.slice(0, 25).map((s) => `    ${s}`).join('\n') + (items.length > 25 ? `\n    … and ${items.length - 25} more` : '');
const missing = [...expected].filter((f) => !ranBy.has(f)).sort();
const twice = [...ranBy].filter(([, shards]) => shards.length > 1).map(([f, shards]) => `${f} (shards ${shards.join(', ')})`).sort();
const unexpected = [...ranBy.keys()].filter((f) => !expected.has(f)).sort();
if (missing.length) problems.push(`${missing.length} test file(s) ran in NO shard:\n${list(missing)}`);
if (twice.length) problems.push(`${twice.length} test file(s) ran in MORE THAN ONE shard:\n${list(twice)}`);
if (unexpected.length) problems.push(`${unexpected.length} file(s) ran that the suite's file list does not contain:\n${list(unexpected)}`);

if (problems.length) {
  for (const problem of problems) console.log(`::error::API test shard partition: ${problem.split('\n')[0].replace(/:$/, '')}`);
  console.error(`\nAPI test shard partition FAILED\n\n${problems.join('\n\n')}`);
  process.exit(1);
}
console.log(`ok: ${expected.size} API test files, each ran in exactly one of ${count} shards (${perShard.join(' + ')})`);
