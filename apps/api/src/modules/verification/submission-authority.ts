import { Prisma, type UserRole, type VehicleType } from '@prisma/client';
import type { EvidenceDb } from './evidence';
import { AppError, NotFoundError } from '../../utils/errors';
import { normalizeRegistrationMark } from './subjects';

export interface VehicleSubmissionProfile {
  id: string;
  kind: 'RIDER' | 'DRIVER';
  updatedAt: Date;
  licensePlate: string | null;
  vehicleType: VehicleType;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleColor: string | null;
}
export interface SubmissionAuthority {
  activeRole: UserRole;
  userUpdatedAt: Date;
  profile: VehicleSubmissionProfile | null;
}
const profileSelect = {
  id: true, updatedAt: true, licensePlate: true, vehicleType: true,
  vehicleMake: true, vehicleModel: true, vehicleYear: true, vehicleColor: true,
} as const;

export function moverProfileRequired(): AppError {
  return new AppError(409, 'MOVER_PROFILE_REQUIRED', 'Choose Rider or Driver before submitting vehicle documents.');
}
export function moverAuthorityChanged(): AppError {
  return new AppError(409, 'MOVER_AUTHORITY_CHANGED', 'Your mover profile changed. Check the vehicle and submit again.');
}

/** Capture before processing. Generic MOVER may use a sole profile, never a guessed dual profile. */
export async function captureSubmissionAuthority(db: EvidenceDb, userId: string, authenticatedRole?: string): Promise<SubmissionAuthority> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { activeRole: true, updatedAt: true } });
  if (!user) throw new NotFoundError('User', userId);
  if (authenticatedRole !== undefined && user.activeRole !== authenticatedRole) throw moverAuthorityChanged();
  const rider = await db.rider.findUnique({ where: { userId }, select: profileSelect });
  const driver = await db.driver.findUnique({ where: { userId }, select: profileSelect });
  const role = authenticatedRole ?? user.activeRole;
  let profile: VehicleSubmissionProfile | null;
  if (role === 'RIDER' || role === 'DRIVER') {
    const selected = role === 'RIDER' ? rider : driver;
    if (!selected) throw moverProfileRequired();
    profile = { ...selected, kind: role };
  } else {
    if (rider && driver) throw moverProfileRequired();
    profile = rider ? { ...rider, kind: 'RIDER' } : driver ? { ...driver, kind: 'DRIVER' } : null;
  }
  return { activeRole: user.activeRole, userUpdatedAt: user.updatedAt, profile };
}

/** Caller owns User FOR UPDATE. Profile writers take that same User first. */
export async function revalidateSubmissionAuthority(tx: Prisma.TransactionClient, userId: string, expected: SubmissionAuthority): Promise<void> {
  if (expected.profile?.kind === 'RIDER') {
    await tx.$queryRaw`SELECT id FROM riders WHERE "userId" = ${userId} FOR UPDATE`;
  } else if (expected.profile?.kind === 'DRIVER') {
    await tx.$queryRaw`SELECT id FROM drivers WHERE "userId" = ${userId} FOR UPDATE`;
  }
  let current: SubmissionAuthority;
  try { current = await captureSubmissionAuthority(tx, userId, expected.activeRole); }
  catch (error) {
    if (error instanceof AppError && ['MOVER_PROFILE_REQUIRED', 'MOVER_AUTHORITY_CHANGED'].includes(error.code)) throw moverAuthorityChanged();
    throw error;
  }
  const a = current.profile; const b = expected.profile;
  if (current.userUpdatedAt.getTime() !== expected.userUpdatedAt.getTime()
    || a?.id !== b?.id || a?.kind !== b?.kind || a?.vehicleType !== b?.vehicleType
    || a?.updatedAt.getTime() !== b?.updatedAt.getTime()
    || normalizeRegistrationMark(a?.licensePlate ?? '') !== normalizeRegistrationMark(b?.licensePlate ?? '')) {
    throw moverAuthorityChanged();
  }
}
