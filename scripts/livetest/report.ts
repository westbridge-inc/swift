// Journey results [TASK-057]: journeys-result.json (machine) and
// journeys-summary.md (human) in LIVETEST_OUT_DIR. Written atomically enough
// for a one-shot run: the JSON is written last, so its presence means the
// run finished writing.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JourneyResult, TargetInfo } from './journey.js';

export interface RunMeta {
  runId: string;
  baseUrl: string;
  target: TargetInfo & { dataClassification: string; testTenant: string };
  startedAt: string;
  finishedAt: string;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function summaryMarkdown(meta: RunMeta, results: JourneyResult[]): string {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const lines: string[] = [];
  lines.push(`# Pilot journeys — run ${meta.runId}`);
  lines.push('');
  lines.push(`Target: ${meta.baseUrl} · deployment ${meta.target.deploymentId} · environment ${meta.target.environment} · build ${meta.target.buildSha} · data ${meta.target.dataClassification}`);
  lines.push(`Started ${meta.startedAt} · finished ${meta.finishedAt}`);
  lines.push('');
  lines.push(`**${count('PASS')} PASS · ${count('FAIL')} FAIL · ${count('SKIP')} SKIP** of ${results.length} journeys.`);
  lines.push('');
  lines.push('| Journey | Status | Steps (ok/total) | Not proven here / reason |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of results) {
    const ok = r.steps.filter((s) => s.ok).length;
    const note = r.status === 'PASS'
      ? r.skippedCases.map((s) => `${s.gate === 'automated' ? 'automated-only: ' : ''}${s.case}: ${s.reason}`).join('; ')
      : (r.reason ?? '');
    lines.push(`| ${r.journeyId} ${esc(r.title)} | ${r.status} | ${ok}/${r.steps.length} | ${esc(note)} |`);
  }
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.journeyId} — ${r.status}`);
    if (r.reason) lines.push(`Reason: ${r.reason}`);
    for (const s of r.steps) lines.push(`- ${s.ok ? 'ok  ' : s.cleanup ? 'warn' : 'FAIL'} ${s.name} — ${s.detail}`);
    for (const s of r.skippedCases) lines.push(`- ${s.gate === 'automated' ? 'AUTOMATED-ONLY' : 'SKIP'} ${s.case} — ${s.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function writeResults(outDir: string, meta: RunMeta, results: JourneyResult[]): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const md = join(outDir, 'journeys-summary.md');
  const json = join(outDir, 'journeys-result.json');
  writeFileSync(md, summaryMarkdown(meta, results));
  writeFileSync(json, JSON.stringify(results, null, 2) + '\n');
  return { json, md };
}

/**
 * [STG-DRILLS D7] One journey's row, replaced by a later, separate proof of
 * the same journey (the crash drill writes PLAT-02 after the run). Pure: the
 * other rows and their order are untouched; a row the run never had is added
 * at the end.
 */
export function replaceJourneyRow(results: JourneyResult[], row: JourneyResult): JourneyResult[] {
  const at = results.findIndex((r) => r.journeyId === row.journeyId);
  if (at < 0) return [...results, row];
  return results.map((r, i) => (i === at ? row : r));
}

/**
 * Write a separately proven row next to the run's results: `<file>` holds the
 * row alone; when the run's journeys-result.json exists, its row for the same
 * journey is replaced (the original file is kept once, as
 * journeys-result.before-<file>), and journeys-summary.md is rewritten from
 * the merged rows so its counts stay true.
 */
export function writeReplacedRow(outDir: string, file: string, row: JourneyResult, meta: Omit<RunMeta, 'startedAt' | 'finishedAt'>): { row: string; merged: string | null } {
  mkdirSync(outDir, { recursive: true });
  const rowPath = join(outDir, file);
  writeFileSync(rowPath, JSON.stringify(row, null, 2) + '\n');
  const json = join(outDir, 'journeys-result.json');
  if (!existsSync(json)) return { row: rowPath, merged: null };
  const backup = join(outDir, `journeys-result.before-${file}`);
  if (!existsSync(backup)) copyFileSync(json, backup);
  const results = replaceJourneyRow(JSON.parse(readFileSync(json, 'utf8')) as JourneyResult[], row);
  const startedAt = results.map((r) => r.startedAt).sort()[0] ?? row.startedAt;
  const finishedAt = results.map((r) => r.finishedAt).sort().at(-1) ?? row.finishedAt;
  writeFileSync(join(outDir, 'journeys-summary.md'), summaryMarkdown({ ...meta, startedAt, finishedAt }, results));
  writeFileSync(json, JSON.stringify(results, null, 2) + '\n');
  return { row: rowPath, merged: json };
}
