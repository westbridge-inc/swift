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

/** [Owner ruling 11 Oct 2026 — H-PLATE: KEEP] A taxi (car / wagon car) plate in Guyana is H-series
 *  (GRA: "Hire Car — HD"). The server refuses any other taxi plate (TAXI_PLATE_NOT_HIRE) in the same
 *  words; the page says it before the button is pressed. Delivery vehicles are not judged. */
export const TAXI_PLATE_HINT = 'Taxi plates in Guyana start with H — e.g. HC 1234.';
export const TAXI_PLATE_ERROR = 'Taxi plates in Guyana start with H — e.g. HC 1234. Enter the plate on your Certificate of Registration; a private (P) plate cannot be approved for taxi work.';
export function isHirePlate(plate: string): boolean {
  return plate.toUpperCase().replace(/[\s-]+/g, '').startsWith('H');
}
