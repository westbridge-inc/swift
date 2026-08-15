import { PrismaClient } from '@prisma/client';
import { prepareMoverAuthorityCutover } from '../src/modules/mover-authority-cutover-preparation';

const CONFIRMATION = 'PREPARE_MOVER_AUTHORITY_CUTOVER';

function requireAuthorization(): void {
  if (process.env['MOVER_AUTHORITY_CUTOVER_CONFIRM'] !== CONFIRMATION) {
    throw new Error(
      `Refusing database mutation: set MOVER_AUTHORITY_CUTOVER_CONFIRM=${CONFIRMATION} only after maintenance mode is active and every old API/worker is stopped`,
    );
  }
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
}

async function main(): Promise<void> {
  requireAuthorization();
  const batchSize = Number(process.env['MOVER_AUTHORITY_PREPARE_BATCH_SIZE'] ?? 1_000);
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const result = await prepareMoverAuthorityCutover(prisma, {
      batchSize,
      onProgress: (progress) => {
        process.stderr.write(`${JSON.stringify({ operation: 'mover-authority-cutover-prepare-progress', ...progress })}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({
      operation: 'mover-authority-cutover-prepare',
      completed: true,
      ...result,
    })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Mover authority cutover preparation failed: ${message}\n`);
  process.exitCode = 1;
});
