// Refuse schema reconciliation in executable setup paths: raw SQL belongs to migrations.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const offenders = [];
const forbidden = /\bprisma\s+(?:[^\n;&]*?\s)?db\s+push\b/i;
// Check a continued command and simple adjacent literal concatenation together.
// This is a static setup-path gate, not an interpreter for computed commands.
function commandText(body) {
  return body.split('\n').filter(line => !/^\s*(?:#|\/\/|\*|<!--)/.test(line)).join('\n')
    .replace(/\\\r?\n/g, ' ')
    .replace(/['"]\s*\+\s*['"]/g, '');
}
for (const file of files) {
  if (/(^|\/)package\.json$/.test(file)) {
    const scripts = JSON.parse(readFileSync(file, 'utf8')).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (forbidden.test(commandText(command))) offenders.push(`${file}: scripts.${name}`);
    }
  } else if (
    /(^|\/)(?:Makefile|makefile|GNUmakefile)$/.test(file)
    || (/^(?:scripts\/|apps\/[^/]+\/scripts\/|infrastructure\/|deploy\/|\.github\/(?:workflows|actions)\/)/.test(file)
      && /\.(?:sh|bash|zsh|ts|js|mjs|cjs|py|mk|yml|yaml)$/.test(file))
  ) {
    if (forbidden.test(commandText(readFileSync(file, 'utf8')))) offenders.push(file);
  }
}
if (offenders.length) {
  console.error('Use checked-in migrations in setup scripts:', ...offenders);
  process.exitCode = 1;
} else console.log('Database script gate passed');
