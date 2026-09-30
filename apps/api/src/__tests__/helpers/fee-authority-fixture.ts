import { vi } from 'vitest';
import { Prisma } from '@prisma/client';

// The pricing fakes model the new ownership/member tables too. The actual
// resolver still executes; its dual-role and database-lock laws are covered by
// mover-fee-band and mover-fee-authority against PostgreSQL.
export function authorityTables(rows: () => Array<Record<string, any>>, people: () => Array<Record<string, any>>) {
  const authorities = new Map<string, Record<string, any>>();
  const members: Array<Record<string, any>> = [];
  const source = (row: Record<string, any>): Record<string, any> => ({
    riderId: null, driverId: null, vendorId: null, rider: null, driver: null, vendor: null,
    status: 'ACTIVE', customRate: null, feeWaived: false, createdAt: new Date(0), ...row,
    weeklyRate: new Prisma.Decimal(row['weeklyRate'] ?? 1),
  });
  const all = () => rows().map(source);
  const owner = (row: Record<string, any>) => row['rider']?.user?.id ?? row['driver']?.user?.id ?? row['vendor']?.owner?.user?.id;
  const find = async ({ where }: { where: { id: string } }) => all().find((r) => r['id'] === where.id) ?? null;
  return {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => people().find((u) => u['id'] === where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => people().find((u) => u['id'] === where.id)!) },
    subscription: {
      findUnique: vi.fn(find), findUniqueOrThrow: vi.fn(find),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; OR?: Array<{ rider?: { userId: string }; driver?: { userId: string } }> } }) =>
        all().filter((r) => where.id ? where.id.in.includes(r['id']) : owner(r) === (where.OR?.[0]?.rider?.userId ?? where.OR?.[1]?.driver?.userId))),
    },
    moverFeeAuthority: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const row = authorities.get(where.userId);
        return row ? { ...row, members: members.filter((m) => m['userId'] === where.userId) } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: { userId: string }; create: Record<string, any>; update: Record<string, any> }) => {
        const row = authorities.has(where.userId) ? { ...authorities.get(where.userId), ...update } : create;
        authorities.set(where.userId, row); return row;
      }),
    },
    moverFeeSubscription: { createMany: vi.fn(async ({ data }: { data: Array<Record<string, any>> }) => {
      for (const m of data) if (!members.some((old) => old['subscriptionId'] === m['subscriptionId'])) members.push(m);
      return { count: data.length };
    }) },
    auditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `decision-${authorities.size}-${members.length}`, ...data })) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      if (sql.includes('FROM "users"')) return people().filter((u) => u['id'] === values[0]);
      if (sql.includes('LEFT JOIN "riders"')) return all().filter((r) => owner(r) === values[0]).map((r) => ({ id: r['id'] }));
      return [];
    }),
  };
}
