import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [ADM-002 / ADM-004] A DECLARED FIELD THAT DOES NOT EXIST IS A DIFF THAT SAYS
// NOTHING.
//
// `declaredFields()` keeps only the names present on the row, so a typo in the
// authority table is not an error — it is a silently empty diff. `E.order`
// declared `total` and `refundStatus`, neither of which Order has ever had,
// and `E.returnRequest` declared `resolvedAt` where the column is `reviewedAt`.
// Every order refund route therefore recorded a status change and nothing
// about the money. The census below is the looks-wired-isn't guard: each
// declared field must be a real column of its Prisma model.
// ---------------------------------------------------------------------------

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [lowerFirst(m.name), new Set(m.fields.map((f) => f.name))]));

describe('[ADM-002] every declared audit field exists on its model', () => {
  it('names only real columns', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const [route, authority] of Object.entries(ADMIN_ROUTE_AUTHORITY)) {
      const entity = authority.entity;
      if (!entity) continue;
      const key = `${entity.model}:${entity.fields.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fields = models.get(entity.model);
      if (!fields) { problems.push(`${route}: model '${entity.model}' is not in the schema`); continue; }
      for (const f of entity.fields) {
        if (!fields.has(f)) problems.push(`${route}: ${entity.model}.${f} does not exist`);
      }
      // [C-01] How the row is addressed. This census once COMPUTED the correct
      // rule — `param` when the model has such a column, `id` otherwise — and
      // asserted it against the authority table while the runtime did something
      // else entirely (`entity.param === 'key' ? { key: id } : { id }`). It
      // passed the whole time. A static census can only check that the DECLARED
      // selector is a real column; whether the runtime USES it is a behaviour
      // question, and `admin-audit-unique-selector.test.ts` is where it is asked
      // by watching the arguments Prisma actually receives. This is the
      // secondary gate. That one is the oracle.
      const uniqueField = entity.uniqueField ?? 'id';
      if (!fields.has(uniqueField)) {
        problems.push(`${route}: ${entity.model} has no '${uniqueField}' column to select on`);
      }
      // The route parameter must be a real segment of the route template, or the
      // hook reads `params[undefined]` and every snapshot for it is ABSENT.
      const routeParam = entity.routeParam ?? 'id';
      const segments = new Set(route.split(/[/\s]/).filter((s) => s.startsWith(':')).map((s) => s.slice(1)));
      if (segments.size > 0 && !segments.has(routeParam)) {
        problems.push(`${route}: declares routeParam ':${routeParam}', which the template does not carry`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the money entities declare the columns a refund actually moves', () => {
    const order = ADMIN_ROUTE_AUTHORITY['PUT /orders/:id/refund-settled']?.entity;
    const ret = ADMIN_ROUTE_AUTHORITY['PUT /returns/:id/refund-settled']?.entity;
    expect(order?.fields).toEqual(expect.arrayContaining(['refundRef', 'refundPaidAmount', 'refundSettledAt']));
    expect(ret?.fields).toEqual(expect.arrayContaining(['refundRef', 'refundPaidAmount', 'refundPaidAt']));
  });
});
