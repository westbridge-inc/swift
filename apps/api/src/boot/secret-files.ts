/**
 * Boot-time secret delivery — import this module FIRST in every entrypoint.
 *
 * Imports are hoisted and evaluated in order, so only a first-position
 * side-effect import runs before any module in the import graph reads
 * `process.env` at module scope. It turns every NAME_FILE into NAME in this
 * process's memory and assembles DATABASE_URL from the POSTGRES_* parts; a
 * refusal prints the message (a variable and a path, never a value) and exits
 * before anything else can start.
 */
import { applySecretFiles, assembleDatabaseUrl } from '../utils/secret-files';

try {
  applySecretFiles(process.env);
  assembleDatabaseUrl(process.env);
} catch (error) {
  // The message only. A stack adds nothing an operator can act on here, and
  // this is the one place a value must never reach a log.
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : 'FATAL: secret files could not be loaded. Refusing to start.');
  process.exit(1);
}
