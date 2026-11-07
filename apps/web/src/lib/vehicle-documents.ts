import { documentLabel } from './taxi-documents';

/**
 * [WEB-WORDING · 1 Nov 2026] The documents each vehicle signs up with, as the public drivers page states them.
 * The same lists as the server's launch checklists (apps/api ops/platform-config DEFAULT_DOCUMENT_CHECKLISTS:
 * MOVER_MOTOR, MOVER_NO_LICENCE, MOVER_TAXI_EXTRA); app/(marketing)/partner-wording.test.ts pins the parity.
 * Names come from documentLabel, the same words the partner's Documents page shows. `profiles` is the server's
 * vehicle -> checklist map for these vehicles (apps/api config/vehicle-classes docProfiles), pinned by the same test.
 * [R13 · owner 15 Oct 2026] Every motor vehicle's insurance must permit use for hire or reward (verification.service
 * rejects a private-use policy as INSURANCE_NOT_HIRE), so both motor cards say so.
 */
export const MOTOR_DOCUMENTS = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'] as const;
export const BICYCLE_DOCUMENTS = ['national_id'] as const;
export const TAXI_DOCUMENTS = [...MOTOR_DOCUMENTS, 'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'] as const;

export const VEHICLE_DOCUMENTS = [
  {
    vehicle: 'Motorbike rider',
    vehicleTypes: ['MOTORCYCLE'],
    profiles: ['MOVER_MOTOR'],
    docs: MOTOR_DOCUMENTS,
    // [owner ruling 1 Nov 2026, D5] "Bicycle" means pedal only; any motor takes the motorbike documents.
    note: 'Your licence must cover a motorbike, and your insurance must permit use for hire or reward (commercial use): a private-use policy is not accepted. A bicycle with any kind of motor signs up as a motorbike.',
  },
  {
    vehicle: 'Bicycle rider',
    vehicleTypes: ['BICYCLE'],
    profiles: ['MOVER_NO_LICENCE'],
    docs: BICYCLE_DOCUMENTS,
    note: 'Pedal bicycles only. You will not be asked for a licence, registration or insurance.',
  },
  {
    vehicle: 'Taxi driver',
    vehicleTypes: ['CAR', 'WAGON_CAR'],
    profiles: ['MOVER_MOTOR', 'MOVER_TAXI_EXTRA'],
    docs: TAXI_DOCUMENTS,
    note: "Your Hire Car Driver's Licence is a separate licence from GRA, and your insurance must permit use for hire or reward, covering passengers carried for hire. A police clearance is optional.",
  },
].map((v) => ({ ...v, labels: v.docs.map(documentLabel) }));
