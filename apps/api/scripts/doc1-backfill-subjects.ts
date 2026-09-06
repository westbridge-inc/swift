/**
 * [DOC-1 §4.3 · P1-2] Fill `VerificationDocument.subjectId` on rows that predate subjects.
 * Idempotent; safe to re-run; prints counts. A document whose account holds no plate stays
 * unresolved (no vehicle subject without a registration mark) and is counted.
 *   pnpm doc1:backfill-subjects [--limit N]
 */
import { PrismaClient } from '@prisma/client';
import { backfillSubjects } from '../src/modules/verification/subjects';

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : undefined;
const prisma = new PrismaClient();
backfillSubjects(prisma, { limit })
  .then((r) => { console.log(`subjects backfill: scanned ${r.scanned}, resolved ${r.resolved}, unresolved ${r.unresolved}`); return prisma.$disconnect(); })
  .catch((e) => { console.error(e); process.exit(1); });
