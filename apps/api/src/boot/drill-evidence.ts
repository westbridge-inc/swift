/**
 * [STG-DRILLS D7 · AX324 R7] The crash drill's durable evidence, read-only, run
 * inside the worker container by deploy/drill-crash.sh after the drill order
 * is delivered — never a route, never a job:
 *
 *   node dist/boot/drill-evidence.js crash --order <order id>
 *
 * Refuses unless the drill guard passes (modules/ops/drills/guard.ts); prints
 * one JSON line (modules/ops/drills/evidence.ts: offer publications, offer
 * pushes, the dispatch journal and the status log of that one order).
 * Exit: 0 done · 1 failed · 2 usage · 3 refused.
 */
// FIRST: secrets delivered as files (NAME_FILE) become NAME and DATABASE_URL is
// assembled in memory, before any module below reads process.env.
import './secret-files';
import { drillEvidenceMain } from '../modules/ops/drills/cli';

drillEvidenceMain(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));
