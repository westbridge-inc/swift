/**
 * [PLACES-LOUD 22 Oct 2026] One-shot launch smoke for address search, run INSIDE the
 * production API container at the launch deploy (deploy/PILOT-RUNBOOK.md section 12):
 *
 *     docker compose -f deploy/docker-compose.yml exec -T api node dist/scripts/places-smoke.js
 *
 * Three real Google calls (autocomplete "Giftland" in Guyana, one place details, one
 * reverse geocode). Prints PASS/FAIL per call and Google's status words only; exits 0
 * when all pass, 1 when a call fails, 2 when this container is not set up for Google.
 * Never prints the key. Logic and tests: providers/places/places-smoke.ts.
 */
// FIRST: the key arrives as GOOGLE_MAPS_API_KEY_BACKEND_FILE; turn it into the variable
// in this process's memory exactly as the server does. Keep this import on top.
import '../boot/secret-files';
import { placesSmokeMain } from '../providers/places/places-smoke';

const print = (line: string) => { process.stdout.write(`${line}\n`); };

placesSmokeMain(process.env, print).then(
  (code) => { process.exitCode = code; },
  () => { print('FAIL places smoke: unexpected error (no detail printed)'); process.exitCode = 1; },
);
