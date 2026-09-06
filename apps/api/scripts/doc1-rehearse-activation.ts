/**
 * [DOC-1 P10-4] Rehearse a registry activation against a real database and
 * print the founder-facing report. Writes NOTHING except the idempotent
 * registry seed (the same one boot runs).
 *
 *   pnpm doc1:rehearse -- --country GY --types all
 *   pnpm doc1:rehearse -- --country GY --types storefront_photo,business_registration --out rehearsal.json
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';
import { seedDocRegistry } from '../src/modules/verification/doc-registry';
import { VerificationService } from '../src/modules/verification/verification.service';
import { NotificationService } from '../src/modules/notification/notification.service';
import { getKycProvider } from '../src/providers/kyc/kyc-provider';
import { rehearseActivation, renderRehearsal } from '../src/modules/verification/activation-rehearsal';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const countryCode = arg('country', 'GY');
    const typesArg = arg('types', 'all');
    const out = arg('out', '');
    await seedDocRegistry(prisma);
    const io = { to: () => ({ emit: () => {} }), emit: () => {} } as never;
    const service = new VerificationService(prisma, new NotificationService(prisma, io), getKycProvider());
    const report = await rehearseActivation(prisma, service, { countryCode, legacyCodes: typesArg === 'all' ? 'ALL' : typesArg.split(',').map((s) => s.trim()).filter(Boolean) });
    process.stdout.write(renderRehearsal(report) + '\n');
    if (out) { writeFileSync(out, JSON.stringify(report, null, 2)); process.stdout.write(`\nJSON written to ${out}\n`); }
    process.exitCode = report.zeroSuspended ? 0 : 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
