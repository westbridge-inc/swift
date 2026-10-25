/** Profile discovery may fall back to the other mover kind only when the
 * server definitively says this profile does not exist. Network, auth, and 5xx
 * failures must remain errors; treating them as absence can silently cross
 * from an active Rider job into the Driver UI.
 *
 * A 403 is definitive too, for exactly one caller: an account that holds no
 * mover role at all. The server refuses a self-profile read of an unheld role
 * with 403 rather than 404 (its authz matrix pins that — no route oracle for
 * a wrong-role token), so a customer opening "Swift Driver" to apply used to
 * hit 403 on BOTH probes, retried each three times, and carry an error into a
 * screen that was only ever going to show the application. `outsider` comes
 * from the account's OWN roles (lib/roleLanding accountHoldsRole): for such an
 * account 403 means "no profile", and for an account that holds the role it
 * stays the error it is. */
export async function unwrapOptionalMoverProfile<T>(
  request: Promise<any>,
  opts: { outsider?: boolean } = {},
): Promise<T | null> {
  try {
    const response = await request;
    return response?.data?.data as T;
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404) return null;
    if (status === 403 && opts.outsider === true) return null;
    throw error;
  }
}

export type OperationalMoverKind = 'DRIVER' | 'RIDER';

export interface MoverProfileShape {
  isOnline?: boolean;
  currentRideId?: string | null;
  currentOrderId?: string | null;
}

export interface MoverProfileResolution<T extends MoverProfileShape = MoverProfileShape> {
  kind: OperationalMoverKind | null;
  profile: T | null;
  ambiguous: boolean;
}

/** Resolve both profiles without guessing. Live work outranks potentially stale
 * account memory from another device; exactly-one online supply is next, then
 * current/remembered authority, then a single existing profile. */
export function resolveMoverProfile<
  D extends MoverProfileShape,
  R extends MoverProfileShape,
>({
  activeRole,
  lastMoverRole,
  driver,
  rider,
}: {
  activeRole?: string | null;
  lastMoverRole?: string | null;
  driver: D | null;
  rider: R | null;
}): MoverProfileResolution<D | R> {
  const choose = (kind: OperationalMoverKind): MoverProfileResolution<D | R> => ({
    kind,
    profile: kind === 'DRIVER' ? driver : rider,
    ambiguous: false,
  });
  if (driver && !rider) return choose('DRIVER');
  if (rider && !driver) return choose('RIDER');
  if (!driver && !rider) return { kind: null, profile: null, ambiguous: false };

  const driverActive = !!driver?.currentRideId;
  const riderActive = !!rider?.currentOrderId;
  if (driverActive !== riderActive) return choose(driverActive ? 'DRIVER' : 'RIDER');

  const driverOnline = !!driver?.isOnline;
  const riderOnline = !!rider?.isOnline;
  if (driverOnline !== riderOnline) return choose(driverOnline ? 'DRIVER' : 'RIDER');

  if (activeRole === 'DRIVER' || activeRole === 'RIDER') return choose(activeRole);
  if (lastMoverRole === 'DRIVER' || lastMoverRole === 'RIDER') return choose(lastMoverRole);
  return { kind: null, profile: null, ambiguous: true };
}
