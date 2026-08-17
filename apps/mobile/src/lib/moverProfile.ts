/** Profile discovery may fall back to the other mover kind only when the
 * server definitively says this profile does not exist. Network, auth, and 5xx
 * failures must remain errors; treating them as absence can silently cross
 * from an active Rider job into the Driver UI. */
export async function unwrapOptionalMoverProfile<T>(request: Promise<any>): Promise<T | null> {
  try {
    const response = await request;
    return response?.data?.data as T;
  } catch (error: any) {
    if (error?.response?.status === 404) return null;
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
