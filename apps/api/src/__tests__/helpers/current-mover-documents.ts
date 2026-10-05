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
