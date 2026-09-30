/**
 * [STG-DRILLS] Staging drill fixtures, run once inside the worker container by
 * deploy/drill-fixtures.sh — never a route, never a job:
 *
 *   node dist/boot/drill-fixtures.js create --run-id <id> --admin-phone <+5920…>
 *   node dist/boot/drill-fixtures.js cleanup --run-id <id>
 *
 * Refuses unless the drill guard passes (modules/ops/drills/guard.ts); prints
 * one JSON line (the fixture manifest, or the cleanup report) on stdout.
 * Exit: 0 done · 1 failed · 2 usage · 3 refused.
 */
// FIRST: secrets delivered as files (NAME_FILE) become NAME and DATABASE_URL is
// assembled in memory, before any module below reads process.env.
import './secret-files';
import { drillFixturesMain } from '../modules/ops/drills/cli';

drillFixturesMain(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch(() => process.exit(1));
