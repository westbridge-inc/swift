/**
 * [BUG-HUNT F07] A document's name in a notice, the name the person read on their checklist. Notices used to print the
 * code with its underscores out ("Your owner national id has been approved."). The same list as the phone's
 * components/onboarding/docLabels.ts (doc-names.test.ts holds them together); a code neither knows reads as words.
 */
const DOC_NAMES: Readonly<Record<string, string>> = {
  national_id: 'National ID or Digital ID card',
  drivers_licence: "Driver's Licence",
  vehicle_registration: 'Vehicle Registration',
  vehicle_insurance: 'Vehicle Insurance',
  hire_car_permit: 'Hire-Car Permit',
  hire_car_driver_licence: "Hire Car Driver's Licence",
  hire_car_vehicle_licence: "Car's Hire Licence (yearly, shown on the car)",
  road_service_licence: 'Road Service Licence',
  vehicle_plate_photo: 'Vehicle Plate Photo',
  police_clearance: 'Police Clearance Certificate',
  fitness_cert: 'Fitness Certificate',
  vehicle_exterior_photo: 'Car photo (plate clearly visible)',
  owner_national_id: 'Owner National ID or Digital ID card',
  business_registration: 'Business Registration',
  tin_certificate: 'TIN Certificate',
  gra_restaurant_licence: 'GRA Food Restaurant Licence',
  food_handler_cert: "Food Handler's Certificate",
  storefront_photo: 'Storefront Photo',
  own_name_declaration: 'Own-name declaration',
  food_handler_attestation: 'Food handlers confirmation',
  selfie: 'Selfie',
  gei_electrical_licence: 'GEI Electrical Licence',
  pest_control_operator_licence: 'Pest-Control Operator Licence (PTCCB)',
  pesticide_applicator_certificate: 'Pesticide Applicator Certificate (PTCCB)',
  eating_house_registration: 'Eating-House Registration (Georgetown)',
};

export function docTypeName(docType: string): string {
  return DOC_NAMES[docType] ?? docType.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
