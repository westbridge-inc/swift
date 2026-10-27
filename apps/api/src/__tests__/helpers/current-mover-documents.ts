import type { PrismaClient, VehicleType } from '@prisma/client';
import { CountryConfigService } from '../../modules/country/country-config.service';

/** Real durable approvals for fixtures that exercise a new-custody boundary. */
export async function currentMoverDocuments(db: PrismaClient, userId: string, vehicleType: VehicleType, taxi = false) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { countryCode: true } });
  const checklist = await new CountryConfigService(db).getMoverChecklist(user.countryCode, vehicleType);
  for (const docType of checklist) await db.verificationDocument.create({ data: {
    userId, role: 'MOVER', docType, status: 'APPROVED',
    fileUrl: `storage://synthetic/current-mover/${docType}`, expiresAt: new Date(Date.now() + 86_400_000),
    ...(taxi && docType === 'vehicle_insurance' ? { coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true } : {}),
  } });
}

/** Legacy taxi fixtures still need the two newly required licences; the legacy flag cannot supply them. */
export async function currentTaxiSplitDocuments(db: PrismaClient, userId: string) {
  for (const docType of ['hire_car_driver_licence', 'hire_car_vehicle_licence']) {
    await db.verificationDocument.create({ data: {
      userId, role: 'MOVER', docType, status: 'APPROVED',
      fileUrl: `storage://synthetic/current-taxi/${docType}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    } });
  }
}

/**
 * [CARS-DELIVER] A car delivers only as its owner's VERIFIED taxi car (modules/driver/car-deliveries.ts): the
 * taxi profile names the same car (type and H plate) and the taxi papers are current. A fixture whose delivery
 * mover is a car gives it that taxi profile here: an H plate on both rows, the Driver row, hire-class insurance
 * and the two hire licences.
 */
export async function verifiedTaxiCarProfile(db: PrismaClient, riderId: string) {
  const rider = await db.rider.findUniqueOrThrow({ where: { id: riderId } });
  const plate = /^H/i.test(rider.licensePlate ?? '') ? rider.licensePlate! : `HT ${riderId.slice(-6).toUpperCase()}`;
  if (plate !== rider.licensePlate) await db.rider.update({ where: { id: riderId }, data: { licensePlate: plate } });
  await db.driver.create({ data: {
    userId: rider.userId, vehicleType: rider.vehicleType, vehicleMake: rider.vehicleMake ?? 'Toyota', vehicleModel: rider.vehicleModel ?? 'Allion',
    vehicleYear: rider.vehicleYear ?? 2019, vehicleColor: rider.vehicleColor ?? 'Silver', licensePlate: plate,
    driverLicenseUrl: 'storage://synthetic/dl.jpg', vehicleInsuranceUrl: 'storage://synthetic/ins.jpg', documentsVerified: true,
  } });
  await db.verificationDocument.create({ data: {
    userId: rider.userId, role: 'MOVER', docType: 'vehicle_insurance', status: 'APPROVED',
    fileUrl: 'storage://synthetic/current-taxi/hire-insurance', expiresAt: new Date(Date.now() + 86_400_000),
    coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true,
  } });
  if (await db.verificationDocument.count({ where: { userId: rider.userId, docType: 'hire_car_driver_licence' } }) === 0) {
    await currentTaxiSplitDocuments(db, rider.userId);
  }
}
