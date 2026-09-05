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
      if (entity.param === 'key' ? !fields.has('key') : !fields.has('id')) {
        problems.push(`${route}: ${entity.model} has no '${entity.param ?? 'id'}' selector`);
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
