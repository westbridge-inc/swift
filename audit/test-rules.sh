#!/usr/bin/env bash
# Fixture contract for every local Swift Semgrep rule. No network or installs.
set -euo pipefail

PATH="/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUD="$ROOT/audit"
OUT="$AUD/out"
mkdir -p "$OUT"

semgrep scan --validate --config "$AUD/rules/swift.yml"
semgrep scan --metrics=off --no-git-ignore --config "$AUD/rules/swift.yml" \
  --json --output "$OUT/semgrep-fixtures.json" "$AUD/fixtures" >/dev/null

node - "$AUD/rules/swift.yml" "$AUD/fixtures" "$OUT/semgrep-fixtures.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [rulesPath, fixturesRoot, resultsPath] = process.argv.slice(2);
const defined = new Set(
  [...fs.readFileSync(rulesPath, 'utf8').matchAll(/^\s*- id:\s*([\w-]+)\s*$/gm)].map((match) => match[1]),
);
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')).results ?? [];
const annotations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target);
    else {
      const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const match = line.match(/\/\/\s*(ruleid|ok):\s*([\w-]+)/);
        if (match) annotations.push({ kind: match[1], id: match[2], file: target, line: index + 2 });
      });
    }
  }
}
walk(fixturesRoot);

const positives = new Set(annotations.filter((item) => item.kind === 'ruleid').map((item) => item.id));
const failures = [];
for (const id of defined) {
  if (!positives.has(id)) failures.push(`missing positive fixture: ${id}`);
}
for (const annotation of annotations) {
  const hit = results.some((result) => {
    const resultFile = path.resolve(result.path);
    return result.check_id.endsWith(annotation.id)
      && resultFile === path.resolve(annotation.file)
      && result.start.line === annotation.line;
  });
  if (annotation.kind === 'ruleid' && !hit) {
    failures.push(`expected ${annotation.id} at ${annotation.file}:${annotation.line}`);
  }
  if (annotation.kind === 'ok' && hit) {
    failures.push(`unexpected ${annotation.id} at ${annotation.file}:${annotation.line}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Semgrep fixture contract passed: ${defined.size} rules, ${annotations.length} assertions.\n`);
NODE
