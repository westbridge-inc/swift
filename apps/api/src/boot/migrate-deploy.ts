import './secret-files';
import { spawnSync } from 'node:child_process';

/**
 * `prisma migrate deploy` behind the secret-file loader.
 *
 * The Prisma CLI reads DATABASE_URL from its environment and cannot read a
 * *_FILE, so the migrate container runs this instead: the loader above has
 * already assembled DATABASE_URL in this process, and the CLI inherits it as a
 * child — never as container config, never in argv. Exit status is the CLI's.
 */
const prismaCli = require.resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { stdio: 'inherit' });
if (result.error) {
  // eslint-disable-next-line no-console
  console.error(`FATAL: could not start the Prisma CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
