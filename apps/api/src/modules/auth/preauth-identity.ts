import type { PrismaClient } from '@prisma/client';
import { runAsSystem } from '../../plugins/tenant-context';

/**
 * [L04 · R1 · OTA-016] THE pre-auth identity capability.
 *
 * Signing in starts before anyone's tenant is known: a phone, an email, an
 * access token or a refresh credential has to be turned into an account. On
 * production's contract posture the users table is walled per tenant, so an
 * unbound read sees no account at all and nobody could sign in.
 *
 * Every such read goes through this ONE named system capability, and it
 * answers only who the account is and which tenant it belongs to — never a
 * status, a role, a password hash or a contact detail. The caller then binds
 * that tenant (runWithTenant) BEFORE it reads or writes anything else, so every
 * security decision (status, lockout, password, session state) is made on the
 * walled, tenant-bound connection exactly as before.
 *
 * Sessions carry no tenant and are not walled: a session row is read directly
 * (by its token), and its tenant is its account's, resolved here by id.
 */
export const PREAUTH_IDENTITY_CAPABILITY = 'auth-identity-resolution';

/**
 * The tenant a public sign-up joins: the schema's default (production) tenant
 * that every new account has always been created in. Never chosen by the
 * client; the store-review fiction is provisioned, never signed up.
 */
export const PUBLIC_SIGNUP_TENANT_ID = 'swift-default';

/** An account: who, and which tenant. Nothing else. */
export interface PreAuthIdentity { id: string; tenantId: string }
/** A session: which session, whose, and that account's tenant. Nothing else. */
export interface PreAuthSession { sessionId: string; userId: string; tenantId: string }

type IdentityDb = Pick<PrismaClient, 'user' | 'session'>;
const IDENTITY_FIELDS = { id: true, tenantId: true } as const;

/** The account a phone number belongs to, in any tenant. */
export function resolveIdentityByPhone(prisma: IdentityDb, phone: string): Promise<PreAuthIdentity | null> {
  return runAsSystem(PREAUTH_IDENTITY_CAPABILITY, () => prisma.user.findUnique({ where: { phone }, select: IDENTITY_FIELDS }));
}

/** The account an email belongs to, in any tenant. */
export function resolveIdentityByEmail(prisma: IdentityDb, email: string): Promise<PreAuthIdentity | null> {
  return runAsSystem(PREAUTH_IDENTITY_CAPABILITY, () => prisma.user.findUnique({ where: { email }, select: IDENTITY_FIELDS }));
}

/** The account a session belongs to (its row names the account), in any tenant. */
export function resolveIdentityById(prisma: IdentityDb, userId: string): Promise<PreAuthIdentity | null> {
  return runAsSystem(PREAUTH_IDENTITY_CAPABILITY, () => prisma.user.findUnique({ where: { id: userId }, select: IDENTITY_FIELDS }));
}

async function sessionIdentity(prisma: IdentityDb, where: { OR: Array<{ refreshToken: string } | { previousRefreshToken: string }> }): Promise<PreAuthSession | null> {
  const session = await prisma.session.findFirst({ where, select: { id: true, userId: true } });
  if (!session) return null;
  const account = await resolveIdentityById(prisma, session.userId);
  return account ? { sessionId: session.id, userId: account.id, tenantId: account.tenantId } : null;
}

/** The session a refresh credential belongs to: its current refresh token, or the one just rotated out. */
export function resolveSessionByRefreshCredential(prisma: IdentityDb, credential: string): Promise<PreAuthSession | null> {
  if (!credential) return Promise.resolve(null);
  return sessionIdentity(prisma, { OR: [{ refreshToken: credential }, { previousRefreshToken: credential }] });
}
