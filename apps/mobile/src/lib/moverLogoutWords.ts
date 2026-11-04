// [BUG-HUNT F18 · COORD 4 Nov 2026] What the log-out box tells a rider or driver, for what they are holding right now.
// What the server does (mover-authority.ts, safety/incident.service.ts): a job not picked up goes back to dispatch.
// A session that ends with goods in the bag suspends the account until that delivery is finished, and it comes back by
// itself. A passenger in the car, or goods on their way back, stay with a person to review. The box used to say only
// the first of these, so an honest log-out to fix a glitch cost the working day with no warning.

export const LOGOUT_NOTHING_IN_HAND = 'You’ll go offline, and a job you haven’t picked up yet goes back to dispatch. Your earnings, vehicle and documents stay with your account.';
export const LOGOUT_WITH_GOODS = 'You have an order in your care. If you log out now, your account is suspended until that delivery is finished. Sign back in and finish it, and your account comes back by itself.';
export const LOGOUT_WITH_PASSENGER = 'You have a passenger in your car. If you log out now, your account is suspended until a person at Swift reviews it. Finish the trip first.';
export const LOGOUT_ON_THE_WAY_BACK = 'You have an order on its way back. If you log out now, your account is suspended until a person at Swift reviews it. Finish the return first.';

const GOODS_IN_THE_BAG: ReadonlySet<string> = new Set(['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED']);

type HeldJob = { status?: unknown; ridePinVerified?: unknown } | null | undefined;

/** The worst thing the person is holding decides: a passenger, then goods coming back, then goods going out. */
export function moverLogoutBody(jobs: readonly HeldJob[]): string {
  const held = jobs.filter((job): job is NonNullable<HeldJob> => !!job);
  if (held.some((job) => job.status === 'RIDE_IN_PROGRESS' || job.ridePinVerified === true)) return LOGOUT_WITH_PASSENGER;
  if (held.some((job) => job.status === 'RETURNING')) return LOGOUT_ON_THE_WAY_BACK;
  if (held.some((job) => typeof job.status === 'string' && GOODS_IN_THE_BAG.has(job.status))) return LOGOUT_WITH_GOODS;
  return LOGOUT_NOTHING_IN_HAND;
}
