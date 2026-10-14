import { PrismaClient } from '@prisma/client';
import { attestationOf, readRlsFacts, type RlsFacts } from '../lib/rls-attestation';
import { runtimeMode } from '../utils/runtime-mode';

type EnvLike = Record<string, string | undefined>;
type RawDb = Pick<PrismaClient, '$queryRaw'>;
interface BootLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Read the system login's own facts on a short-lived connection, always closed. */
async function probeSystemLogin(url: string): Promise<RlsFacts> {
  const probe = new PrismaClient({ datasourceUrl: url });
  try {
    return await readRlsFacts(probe);
  } finally {
    await probe.$disconnect().catch(() => {});
  }
}

/**
 * [L04 · R1 follow-up] Under the enforced tenant wall the request login reads
 * only the tenant it is bound to. Three things read through the SYSTEM login
 * (SYSTEM_DATABASE_URL) instead: the account lookup at sign-in, before any
 * tenant is known; SOS escalation; and every system job. A missing system
 * login, one that cannot be reached, or one that is not a member of
 * swift_bypass_rls makes those reads return NOTHING — every signed-in user is
 * answered 401 (and the apps drop their tokens), existing users look new, and
 * system work silently finds no rows. That posture used to boot green.
 *
 * So, in production, when the request login is walled (the attestation says
 * `enforced`), the API and the worker refuse to start unless the system login
 * is reachable and a bypass member. The request login of an enforced wall is
 * never a bypass member, so a system login that IS the request login is
 * refused by the same check. Every other posture — the wall-less EXPAND
 * deployment (staging today) and every non-production mode — starts exactly
 * as before: there, system work runs on a login that already sees every row.
 *
 * The error names roles only, never the connection string or its password.
 */
export async function attestSystemLoginAtBoot(
  requestDb: RawDb,
  log: BootLog,
  env: EnvLike = process.env,
  probe: (url: string) => Promise<RlsFacts> = probeSystemLogin,
): Promise<void> {
  if (runtimeMode(env) !== 'production') return;
  const request = attestationOf(await readRlsFacts(requestDb));
  if (!request.enforced) return;

  const url = env['SYSTEM_DATABASE_URL'];
  const gaps: string[] = [];
  let system: RlsFacts | null = null;
  if (!url) {
    gaps.push('SYSTEM_DATABASE_URL is not set — there is no system login at all');
  } else {
    try {
      system = await probe(url);
    } catch (err) {
      const code = (err as { errorCode?: unknown; code?: unknown })?.errorCode ?? (err as { code?: unknown })?.code;
      gaps.push(`the system login could not be reached (${typeof code === 'string' ? code : 'connection failed'}) — check SYSTEM_DATABASE_URL`);
    }
  }
  if (system && !system.roleResolved) {
    gaps.push('the system login\'s role could not be read from pg_roles — its posture is unknown');
  } else if (system && !system.isBypassRoleMember) {
    gaps.push(`the system login (${system.role}) is not a member of swift_bypass_rls${system.role === request.facts.role ? ' — it is the request login itself' : ''}`);
  }

  if (gaps.length === 0 && system) {
    log.info({ requestRole: request.facts.role, systemRole: system.role }, 'tenant wall: system login is a bypass member');
    return;
  }
  throw new Error(
    `FATAL: the database tenant wall binds this process's request login (${request.facts.role}), but its system login does not hold up its end:\n` +
      gaps.map((g) => `  - ${g}`).join('\n') + '\n' +
      'Under the wall, sign-in (the account lookup before the tenant is known), SOS escalation and every system job read through the system login. ' +
      'Without a reachable login that is a member of swift_bypass_rls they read NOTHING: every signed-in user is answered 401, existing users look new, and system work finds no rows. ' +
      'Set SYSTEM_DATABASE_URL (or SYSTEM_DATABASE_URL_FILE) to the system login and restart. Refusing to start.',
  );
}
