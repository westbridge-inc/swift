/**
 * [STG-DRILLS] The staging run-once job trigger, run inside the worker
 * container by deploy/drill-run-job.sh — never a route, never a queue entry:
 *
 *   node dist/boot/drill-run-job.js <settlement-digest|convert-trials|billing-cycle> [...]
 *
 * Runs the SAME functions the worker's processors run (modules/ops/drills/jobs.ts),
 * each once, in the order named, and only after the drill guard passes.
 * Prints one JSON line (the runs) on stdout. Exit: 0 done · 1 failed · 2 usage · 3 refused.
 */
// FIRST: secrets delivered as files (NAME_FILE) become NAME and DATABASE_URL is
// assembled in memory, before any module below reads process.env.
import './secret-files';
import { drillRunJobMain } from '../modules/ops/drills/cli';

drillRunJobMain(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));
