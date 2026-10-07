/** [W9] The two kinds of mover the sign-up offers. */
export type MoverRole = 'RIDER' | 'DRIVER';

/** The vehicles each mover can register today, with the app's own names
 *  (MoverOnboardingScreen VTYPES). Canters and box trucks are not offered at
 *  launch (the server refuses them; apps/mobile lib/vehicleOffer). A Rider's
 *  vehicles provision a delivery Rider and a Driver's a taxi Driver on the
 *  server (apps/api config/vehicle-classes moverRoleFor). */
export const MOVER_VEHICLES: Record<MoverRole, { value: string; label: string }[]> = {
  RIDER: [{ value: 'MOTORCYCLE', label: 'Motorbike' }, { value: 'BICYCLE', label: 'Bicycle' }],
  DRIVER: [{ value: 'CAR', label: 'Car' }, { value: 'WAGON_CAR', label: 'Wagon Car' }, { value: 'BUS_9', label: 'Bus (9-seater)' }, { value: 'BUS_15', label: 'Bus (15-seater)' }],
};
