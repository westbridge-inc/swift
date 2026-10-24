/** A canonical UUID (any version), as a Postgres `uuid` column stores it. An
 *  id that is not one names no row in such a table: asking Prisma anyway
 *  fails the whole query ("Error creating UUID") instead of finding nothing. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
