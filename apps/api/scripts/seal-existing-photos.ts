/**
 * [DOC-SECURITY G2] Seal the profile photos and shift selfies stored as plain images before sealing shipped
 * (src/modules/user/seal-existing-photos.ts). Dry run by default: it prints how many there are and changes
 * nothing. Needs MASTER_KEK for a real run. Idempotent; safe to re-run.
 *   pnpm photos:seal-existing            # dry run (counts)
 *   pnpm photos:seal-existing --apply [--limit N]
 */
import { PrismaClient } from '@prisma/client';
import { getStorageProvider } from '../src/providers/storage/storage-provider';
import { sealExistingPhotos } from '../src/modules/user/seal-existing-photos';

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : undefined;
const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();
const log = { warn: (o: Record<string, unknown>, m: string) => console.warn(m, o), error: (o: Record<string, unknown>, m: string) => console.error(m, o) };
sealExistingPhotos(prisma, getStorageProvider(), { dryRun: !apply, ...(limit ? { limit } : {}), log })
  .then((r) => { console.log(`${apply ? 'sealed' : 'dry run (nothing changed)'}: ${JSON.stringify(r)}`); return prisma.$disconnect(); })
  .catch((e) => { console.error(e); process.exit(1); });
