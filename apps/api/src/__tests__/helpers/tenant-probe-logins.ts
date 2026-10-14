import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/** Per-suite logins: parallel lanes never grant privileges to one another's roles. */
export async function createTenantProbeLogins(prisma: Pick<PrismaClient, '$executeRawUnsafe'>, testUrl: string) {
  const suffix = randomBytes(8).toString('hex');
  const requestRole = `l04_request_${suffix}`;
  const systemRole = `l04_system_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const urlFor = (role: string, singleConnection = false) => {
    const url = new URL(testUrl);
    url.username = role;
    url.password = password;
    if (singleConnection) url.searchParams.set('connection_limit', '1');
    return url.toString();
  };
  const cleanup = async () => {
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${requestRole}`);
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${systemRole}`);
  };
  try {
    await prisma.$executeRawUnsafe(`CREATE ROLE ${requestRole} LOGIN PASSWORD '${password}' NOBYPASSRLS`);
    await prisma.$executeRawUnsafe(`CREATE ROLE ${systemRole} LOGIN PASSWORD '${password}' NOBYPASSRLS`);
    await prisma.$executeRawUnsafe(`GRANT swift_app TO ${requestRole}, ${systemRole}`);
    await prisma.$executeRawUnsafe(`GRANT swift_bypass_rls TO ${systemRole}`);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    requestUrl: urlFor(requestRole),
    singleConnectionUrl: urlFor(requestRole, true),
    systemUrl: urlFor(systemRole),
    cleanup,
  };
}
