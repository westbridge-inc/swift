// Entry for the phone-test counterpart helper [PHONE-HELPER] (phone-helper.ts).
// deploy/phone-helper.sh runs it in the journeys runner container, against the
// private api-journeys instance only:
//
//   apps/api/node_modules/.bin/tsx scripts/livetest/phone-helper-run.ts <role> <action> [flags]
//
// Exit: 0 done · 1 the API refused a step, or the helper itself failed · 2 usage · 3 target refused.

import { phoneHelper } from './phone-helper.js';

phoneHelper(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(`FAILED (helper error): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  });
