/** [W9] The two kinds of mover the sign-up offers. */
export type MoverRole = 'RIDER' | 'DRIVER';

/** Owner ruling, 6 Oct 2026: buses ("Group" rides) are hidden at launch. The
 *  website's doors never offer them, whether or not the app and the server
 *  still list them. */
export const LAUNCH_HIDDEN_BUSES: readonly string[] = ['BUS_9', 'BUS_15'];

/** The vehicles each mover can register today, with the app's own names
 *  (MoverOnboardingScreen VTYPES). Canters and box trucks are not offered at
 *  launch (the server refuses them; apps/mobile lib/vehicleOffer), and nor are
 *  buses (LAUNCH_HIDDEN_BUSES above). A Rider's vehicles provision a delivery
 *  Rider and a Driver's a taxi Driver on the server (apps/api
 *  config/vehicle-classes moverRoleFor). */
export const MOVER_VEHICLES: Record<MoverRole, { value: string; label: string }[]> = {
  RIDER: [{ value: 'MOTORCYCLE', label: 'Motorbike' }, { value: 'BICYCLE', label: 'Bicycle' }],
  DRIVER: [{ value: 'CAR', label: 'Car' }, { value: 'WAGON_CAR', label: 'Wagon Car' }],
};
