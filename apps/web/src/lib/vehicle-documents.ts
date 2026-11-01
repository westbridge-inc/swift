import { documentLabel } from './taxi-documents';

/**
 * [WEB-WORDING · 1 Nov 2026] The documents each vehicle signs up with, as the public drivers page states them.
 * The same lists as the server's launch checklists (apps/api ops/platform-config DEFAULT_DOCUMENT_CHECKLISTS:
 * MOVER_MOTOR, MOVER_NO_LICENCE, MOVER_TAXI_EXTRA); app/(marketing)/partner-wording.test.ts pins the parity.
 * Names come from documentLabel, the same words the partner's Documents page shows.
 */
export const MOTOR_DOCUMENTS = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'] as const;
export const BICYCLE_DOCUMENTS = ['national_id'] as const;
export const TAXI_DOCUMENTS = [...MOTOR_DOCUMENTS, 'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'] as const;

export const VEHICLE_DOCUMENTS = [
  {
    vehicle: 'Motorbike rider',
    docs: MOTOR_DOCUMENTS,
    // [owner ruling 1 Nov 2026, D5] "Bicycle" means pedal only; any motor takes the motorbike documents.
    note: 'Your licence must cover a motorbike. A bicycle with any kind of motor signs up as a motorbike.',
  },
  {
    vehicle: 'Bicycle rider',
    docs: BICYCLE_DOCUMENTS,
    note: 'Pedal bicycles only. You will not be asked for a licence, registration or insurance.',
  },
  {
    vehicle: 'Taxi driver',
    docs: TAXI_DOCUMENTS,
    note: "Your Hire Car Driver's Licence is a separate licence from GRA, and your insurance must cover carrying passengers for hire. A police clearance is optional.",
  },
].map((v) => ({ ...v, labels: v.docs.map(documentLabel) }));
