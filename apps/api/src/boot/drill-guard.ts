/**
 * [STG-DRILLS · AX324 R3] The staging drill guard, ALONE, run inside the worker
 * container by deploy/drill-crash.sh before it sets anything up and again
 * right before it kills that worker — never a route, never a job:
 *
 *   node dist/boot/drill-guard.js
 *
 * Judges this container's marker, posture, every database connection and
 * Redis, and the database's own deployment identity
 * (modules/ops/drills/guard.ts); does no work. Prints one JSON line (the
 * target) on stdout. Exit: 0 safe to drill · 2 usage · 3 refused · 1 failed.
 */
// FIRST: secrets delivered as files (NAME_FILE) become NAME and DATABASE_URL is
// assembled in memory, before any module below reads process.env.
import './secret-files';
import { drillGuardMain } from '../modules/ops/drills/cli';

drillGuardMain(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));
