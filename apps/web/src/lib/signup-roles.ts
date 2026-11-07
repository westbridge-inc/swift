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
export const TAXI_PLATE_ERROR = 'Taxi plates in Guyana start with H — e.g. HC 1234. Enter the plate shown on your Certificate of Registration. A private (P) plate cannot be approved for taxi work.';
export function isHirePlate(plate: string): boolean {
  return plate.toUpperCase().replace(/[\s-]+/g, '').startsWith('H');
}

/** [CARS-PLATES · owner 6 Nov 2026] P-plate (private) cars deliver only; H-plate (hire) cars drive taxi rides and
 *  deliver too. While the server says private cars deliver (price list `privateCars.on`), the delivery door also offers
 *  a car on a private plate; the taxi door keeps the H rule. The words match the server and the app. */
export const PRIVATE_CAR_VEHICLES: { value: string; label: string }[] = [
  { value: 'CAR', label: 'Car (private P plate)' },
  { value: 'WAGON_CAR', label: 'Wagon Car (private P plate)' },
];
export function riderVehicles(privateCarsOpen: boolean): { value: string; label: string }[] {
  return privateCarsOpen ? [...MOVER_VEHICLES.RIDER, ...PRIVATE_CAR_VEHICLES] : MOVER_VEHICLES.RIDER;
}
export const isCarVehicle = (vehicleType: string) => vehicleType === 'CAR' || vehicleType === 'WAGON_CAR';
export const PRIVATE_CAR_NOTE = 'A private (P) plate car can do deliveries only. Taxi rides need an H plate.';
export const PRIVATE_CAR_H_PLATE = 'This is an H (hire) plate. Sign up under “Drive a taxi with Swift” to take taxi rides, and add deliveries in your account.';
export const TAXI_DOOR_PRIVATE_CAR = 'A private (P) plate car can sign up under “Deliver with Swift” to do deliveries.';

/** [OPEN-EARLY · owner 31 Oct 2026] The partner doors a link may open straight onto: /signup?as=business|rider|driver.
 *  Only these three. Ordering is never preselected by a link, so `?as=` can never open the customer door
 *  (the public site keeps it closed before launch). */
export type PartnerDoor = 'business' | 'rider' | 'driver';
export const PARTNER_DOORS: Record<PartnerDoor, 'VENDOR' | MoverRole> = { business: 'VENDOR', rider: 'RIDER', driver: 'DRIVER' };

/** The partner door named by a `?as=` value, exactly as written; anything else (customer included) opens no door. */
export function partnerDoorRole(value: string | null | undefined): 'VENDOR' | MoverRole | null {
  return value === 'business' || value === 'rider' || value === 'driver' ? PARTNER_DOORS[value] : null;
}

/** The sign-up address that opens on one partner door. */
export function partnerSignupHref(door: PartnerDoor): string {
  return `/signup?as=${door}`;
}
