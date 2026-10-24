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
 * in a row (the classifier joins "R.U.M" into "rum"). Words written together
 * are read apart too, exactly where the classifier reads them apart: at a
 * change of case before lowercasing ("HennessyVS", "RumCake") and between a
 * letter and a digit after it ("Camel20s", "Rum750ml") — so such an item
 * reaches the catalogue check instead of waiting unseen. The exact verdict is
 * then computed in `prohibited-gate.ts`. Removed items are kept whatever their
 * words. [DS1100 S2; Opus S3-10; DS1265 S4]
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  PROHIBITED_CAMEL_PATTERNS,
  PROHIBITED_CONFUSABLES,
  PROHIBITED_DIGITS_APART_PATTERN,
  PROHIBITED_FORMAT_CHARS_PATTERN,
  PROHIBITED_LEET_FROM,
  PROHIBITED_MARKS_PATTERN,
  PROHIBITED_PREFILTER_WORDS,
  PROHIBITED_ROSE_PATTERN,
  PROHIBITED_SINGLE_LETTER_RUN_PATTERN,
} from './prohibited-items';

type Db = PrismaClient | Prisma.TransactionClient;

export async function prefilterCandidateIds(db: Db, tenantId: string): Promise<string[]> {
  const M = PROHIBITED_MARKS_PATTERN;
  const W = [...PROHIBITED_PREFILTER_WORDS];
  // The column undisguised, capitals kept (see prohibited-items.ts `undisguise`), then as the classifier reads it
  // (matcher `normalize`: NFD, marks removed, lowercased).
  const undisguised = (column: Prisma.Sql) => Prisma.sql`regexp_replace(translate(regexp_replace(normalize(${column}, NFKC), ${PROHIBITED_FORMAT_CHARS_PATTERN}, '', 'g'), ${PROHIBITED_CONFUSABLES.from}, ${PROHIBITED_CONFUSABLES.to}), ${PROHIBITED_ROSE_PATTERN}, 'rosewine', 'g')`;
  const lowered = (text: Prisma.Sql) => Prisma.sql`lower(regexp_replace(normalize(${text}, NFD), ${M}, '', 'g'))`;
  const read = (column: Prisma.Sql) => lowered(undisguised(column));
  // [joined spellings · DS1265 S4] Apart at a change of case, before lowercasing, with the classifier's own patterns.
  const camel = (text: Prisma.Sql) => PROHIBITED_CAMEL_PATTERNS.reduce((t, [pattern, to]) => Prisma.sql`regexp_replace(${t}, ${pattern}, ${to.replace(/\$(\d)/g, '\\$1')}, 'g')`, text);
  const readCamel = (column: Prisma.Sql) => lowered(camel(undisguised(column)));
  // …and a letter apart from the digit after it, once lowercased (and once its l33t is read, as the classifier does).
  const apart = (text: Prisma.Sql) => Prisma.sql`regexp_replace(${text}, ${PROHIBITED_DIGITS_APART_PATTERN}, '\\1 \\2', 'g')`;
  // [evasion] Every l33t character translated, "1" both as "i" and as "l" (the classifier translates only those that
  // touch a letter: a superset); and every pair of adjacent words joined ("hen nessy" → "hennessy").
  const leetOf = (text: Prisma.Sql, one: string) => Prisma.sql`translate(${text}, ${PROHIBITED_LEET_FROM + '1'}, ${'aaeiosstl' + one})`;
  // Each word list is the column as written AND its words apart.
  const tokens = (column: Prisma.Sql, as: (text: Prisma.Sql) => Prisma.Sql) => Prisma.sql`regexp_split_to_array(${as(read(column))} || ' ' || ${apart(as(readCamel(column)))}, '[^a-z0-9]+')`;
  const pairs = (column: Prisma.Sql) => Prisma.sql`EXISTS (SELECT 1 FROM (SELECT regexp_split_to_array(${read(column)}, '[^a-z0-9]+') AS a) t, generate_series(1, greatest(cardinality(t.a) - 1, 0)) k WHERE t.a[k] || t.a[k + 1] = ANY(${W}::text[]))`;
  const words = (column: Prisma.Sql) => Prisma.sql`(${tokens(column, (t) => t)} && ${W}::text[]
    OR ${read(column)} ~ ${PROHIBITED_SINGLE_LETTER_RUN_PATTERN} OR ${readCamel(column)} ~ ${PROHIBITED_SINGLE_LETTER_RUN_PATTERN}
    OR ${tokens(column, (t) => leetOf(t, 'i'))} && ${W}::text[] OR ${tokens(column, (t) => leetOf(t, 'l'))} && ${W}::text[] OR ${pairs(column)})`;
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
