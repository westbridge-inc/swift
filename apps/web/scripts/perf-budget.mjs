#!/usr/bin/env node
// [W2] The website's size budget, checked against the real `next build` output.
//
// What a phone downloads before a page can run is the page's "first-load"
// JavaScript: every script chunk of the page and of each layout above it,
// gzip-compressed (what travels over the wire). This script measures that for
// every customer-facing page and fails the build when a page grows past its
// ceiling in perf-budget.json. Ceilings only come down: they are the measured
// size of each page when it was last tightened, never a guess.
//
// usage: node scripts/perf-budget.mjs [--next <dir>] [--budget <file>] [--report]
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > -1 ? process.argv[at + 1] : fallback;
};
const nextDir = arg('--next', join(here, '..', '.next'));
const budgetFile = arg('--budget', join(here, 'perf-budget.json'));
const report = process.argv.includes('--report');

const manifestPath = join(nextDir, 'app-build-manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`perf-budget: no build at ${nextDir} (run next build first)`);
  process.exit(2);
}
const pages = JSON.parse(readFileSync(manifestPath, 'utf8')).pages;
const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));

const sizeCache = new Map();
function gzipKb(file) {
  if (!sizeCache.has(file)) sizeCache.set(file, gzipSync(readFileSync(join(nextDir, file)), { level: 9 }).length / 1000);
  return sizeCache.get(file);
}

/** "/(app)/order/vendor/[id]/page" → its layouts, outermost first, then itself. */
function entries(page) {
  const parts = page.split('/').filter(Boolean);
  const chain = ['/layout'];
  for (let i = 1; i < parts.length; i += 1) chain.push(`/${parts.slice(0, i).join('/')}/layout`);
  return [...chain.filter((entry) => pages[entry]), page];
}

/** First-load JS of one page, in kB gzip (1 kB = 1000 bytes, the unit `next build` prints). */
function firstLoadKb(page) {
  if (!pages[page]) throw new Error(`perf-budget: ${page} is not in this build`);
  const files = new Set(entries(page).flatMap((entry) => pages[entry]).filter((file) => file.endsWith('.js')));
  let total = 0;
  for (const file of files) total += gzipKb(file);
  return Math.round(total * 10) / 10;
}

let failed = false;
const rows = [];
for (const [page, ceiling] of Object.entries(budget.firstLoadJsKb)) {
  let kb;
  try {
    kb = firstLoadKb(page);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const over = kb > ceiling;
  if (over) failed = true;
  rows.push(`${over ? 'OVER ' : 'ok   '} ${page.padEnd(36)} ${String(kb).padStart(6)} kB  (ceiling ${ceiling} kB, target ${budget.targetKb} kB)`);
}
console.log(rows.join('\n'));
if (report) {
  const all = Object.keys(pages).filter((page) => page.endsWith('/page')).map((page) => [page, firstLoadKb(page)]);
  console.log('\nevery page:');
  for (const [page, kb] of all.sort((a, b) => b[1] - a[1])) console.log(`  ${page.padEnd(40)} ${kb} kB`);
}
if (failed) {
  console.error('\nperf-budget: a page grew past its first-load ceiling. Make it smaller, or — only with a reason in the PR — raise its ceiling in scripts/perf-budget.json.');
  process.exit(1);
}
