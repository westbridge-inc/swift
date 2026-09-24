// Journey results [TASK-057]: journeys-result.json (machine) and
// journeys-summary.md (human) in LIVETEST_OUT_DIR. Written atomically enough
// for a one-shot run: the JSON is written last, so its presence means the
// run finished writing.

import { mkdirSync, writeFileSync } from 'node:fs';
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
      ? r.skippedCases.map((s) => `${s.case}: ${s.reason}`).join('; ')
      : (r.reason ?? '');
    lines.push(`| ${r.journeyId} ${esc(r.title)} | ${r.status} | ${ok}/${r.steps.length} | ${esc(note)} |`);
  }
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.journeyId} — ${r.status}`);
    if (r.reason) lines.push(`Reason: ${r.reason}`);
    for (const s of r.steps) lines.push(`- ${s.ok ? 'ok  ' : s.cleanup ? 'warn' : 'FAIL'} ${s.name} — ${s.detail}`);
    for (const s of r.skippedCases) lines.push(`- SKIP ${s.case} — ${s.reason}`);
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
