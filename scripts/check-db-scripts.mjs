// Refuse schema reconciliation in executable setup paths: raw SQL belongs to migrations.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const offenders = [];
const forbidden = /\bprisma\s+(?:[^\n;&]*?\s)?db\s+push\b/i;
for (const file of files) {
  if (/(^|\/)package\.json$/.test(file)) {
    const scripts = JSON.parse(readFileSync(file, 'utf8')).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (forbidden.test(command)) offenders.push(`${file}: scripts.${name}`);
    }
  } else if (/^(?:scripts\/|apps\/[^/]+\/scripts\/|\.github\/workflows\/)/.test(file) && /\.(?:sh|ts|js|mjs|yml|yaml)$/.test(file)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!/^\s*(?:#|\/\/|\*|<!--)/.test(line) && forbidden.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
}
if (offenders.length) {
  console.error('Use checked-in migrations in setup scripts:', ...offenders);
  process.exitCode = 1;
} else console.log('Database script gate passed');
