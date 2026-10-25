// [UI-SWEEP U73] Friendly document names, in a module with no React Native
// imports so any screen (the rider/driver home's expiring-document banner)
// can name a document without loading the upload card.

function humanize(docType: string) {
  return docType.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
// Friendly names for known checklist docs; unknown slugs fall back to humanize().
const DOC_LABELS: Record<string, string> = {
  // [VERIFY-DOCS · ruling 4] the new Digital ID card is accepted as the national ID
  national_id: 'National ID or Digital ID card',
  drivers_licence: "Driver's Licence",
  vehicle_registration: 'Vehicle Registration',
  vehicle_insurance: 'Vehicle Insurance',
  hire_car_permit: 'Hire-Car Permit',
  // [VERIFY-DOCS · ruling 8] the two licences that replace the permit: the person's and the car's
  hire_car_driver_licence: "Hire Car Driver's Licence",
  hire_car_vehicle_licence: "Car's Hire Licence (yearly, shown on the car)",
  road_service_licence: 'Road Service Licence',
  vehicle_plate_photo: 'Vehicle Plate Photo',
  police_clearance: 'Police Clearance Certificate',
  fitness_cert: 'Fitness Certificate',
  // Owner ruling 2026-10-01: a taxi may be any colour. [VERIFY-DOCS · ruling 5] This one photo
  // replaces the separate plate photo, so the plate must be readable in it.
  vehicle_exterior_photo: 'Car photo (plate clearly visible)',
  owner_national_id: 'Owner National ID or Digital ID card',
  business_registration: 'Business Registration',
  tin_certificate: 'TIN Certificate',
  gra_restaurant_licence: 'GRA Restaurant Licence',
  food_handler_cert: "Food Handler's Certificate",
  storefront_photo: 'Storefront Photo',
  // [ROLE-DOCS · owner 21 Oct 2026] signed in the app in place of a business registration (own name, BNA s.3)
  own_name_declaration: 'Own-name declaration',
  selfie: 'Selfie',
  // [TRADES · 13 Oct 2026; R15 · 15 Oct] service-trade documents of the opened trades, in plain words
  gei_electrical_licence: 'GEI Electrical Licence',
  pest_control_operator_licence: 'Pest-Control Operator Licence (PTCCB)',
  pesticide_applicator_certificate: 'Pesticide Applicator Certificate (PTCCB)',
  eating_house_registration: 'Eating-House Registration (Georgetown)',
};
/** Friendly document name for other surfaces (suspension banners, the expiring-document banner). */
export const docLabel = (docType: string) => DOC_LABELS[docType] ?? humanize(docType);
