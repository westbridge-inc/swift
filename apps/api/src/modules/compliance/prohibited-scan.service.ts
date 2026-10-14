/**
 * [GUARDRAILS §8] The one raw query of the prohibited-items rule: which of a
 * tenant's items COULD carry a banned word. Reached only from requests — the
 * browse surfaces (Market, search) through `hiddenItemIds`, and the admin
 * catalogue check — so the request tenant is bound by the raw-SQL tenant
 * binding, and the tenant is also named in the SQL.
 *
 * Each column is read as the classifier reads text — compatibility forms
 * folded (NFKC: "Ｒｕｍ"), invisible format characters removed ("R\u200Bum"),
 * Cyrillic and Greek look-alikes translated ("Rцm"), "rosé" spelled out, then
 * NFD, combining marks removed (so "Śtout" is "stout" here too), lowercased,
 * split into words — and the row is kept when it shares a word with the
 * pre-filter set, a superset of the word list, or carries two single letters
 * in a row (the classifier joins "R.U.M" into "rum"). The exact verdict is
 * then computed in `prohibited-gate.ts`. Removed items are kept whatever their
 * words. [DS1100 S2; Opus S3-10]
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  PROHIBITED_CONFUSABLES,
  PROHIBITED_FORMAT_CHARS_PATTERN,
  PROHIBITED_MARKS_PATTERN,
  PROHIBITED_PREFILTER_WORDS,
  PROHIBITED_ROSE_PATTERN,
  PROHIBITED_SINGLE_LETTER_RUN_PATTERN,
} from './prohibited-items';

type Db = PrismaClient | Prisma.TransactionClient;

export async function prefilterCandidateIds(db: Db, tenantId: string): Promise<string[]> {
  const M = PROHIBITED_MARKS_PATTERN;
  const W = [...PROHIBITED_PREFILTER_WORDS];
  // The column as the classifier reads it (see prohibited-items.ts `undisguise` and matcher `normalize`).
  const read = (column: Prisma.Sql) => Prisma.sql`lower(regexp_replace(normalize(regexp_replace(translate(regexp_replace(normalize(${column}, NFKC), ${PROHIBITED_FORMAT_CHARS_PATTERN}, '', 'g'), ${PROHIBITED_CONFUSABLES.from}, ${PROHIBITED_CONFUSABLES.to}), ${PROHIBITED_ROSE_PATTERN}, 'rosewine', 'g'), NFD), ${M}, '', 'g'))`;
  const words = (column: Prisma.Sql) => Prisma.sql`(regexp_split_to_array(${read(column)}, '[^a-z0-9]+') && ${W}::text[] OR ${read(column)} ~ ${PROHIBITED_SINGLE_LETTER_RUN_PATTERN})`;
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT i.id FROM items i JOIN categories c ON c.id = i."categoryId"
    WHERE i."tenantId" = ${tenantId}
      AND (i."prohibitedAt" IS NOT NULL
        OR ${words(Prisma.sql`i.name`)}
        OR ${words(Prisma.sql`coalesce(i.description, '')`)}
        OR ${words(Prisma.sql`c.name`)}
        OR EXISTS (SELECT 1 FROM option_groups g WHERE g."itemId" = i.id
          AND (${words(Prisma.sql`g.name`)}
            OR EXISTS (SELECT 1 FROM options o WHERE o."optionGroupId" = g.id AND ${words(Prisma.sql`o.name`)}))))`);
  return rows.map((r) => r.id);
}
