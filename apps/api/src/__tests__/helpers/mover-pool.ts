/**
 * [AUD-G7-042] Emptying the dispatch pool without taking other people's movers
 * offline for good.
 *
 * Dispatch picks from every online, available mover in the database, so a
 * suite that tests "nobody to send" or "only my movers may answer" must first
 * take everyone else offline. Those suites used to do it with an unscoped
 * `updateMany({ data: { isOnline: false } })` (and a grant of the
 * unscoped-mutation capability), and never put anyone back: a mover that was
 * online before the suite — the CI seed's, or another suite's kept one — stayed
 * offline for every suite after it.
 *
 * `begin()` notes which movers existed before the suite made its own.
 * `empty()` takes the online/available ones offline BY ID, remembering each
 * pre-existing mover's state the first time it touches it. `restore()` puts
 * exactly those pre-existing movers back as they were. The suite's own movers
 * are never restored (its teardown owns them).
 */
import type { PrismaClient } from '@prisma/client';

type MoverState = { isOnline: boolean; isAvailable: boolean };
type MoverRow = MoverState & { id: string };
type Off = Partial<Record<keyof MoverState, false>>;

interface MoverTable {
  findMany(args: { where?: object; select: object }): Promise<MoverRow[]>;
  updateMany(args: { where: object; data: object }): Promise<{ count: number }>;
}

export interface MoverPool {
  begin(): Promise<void>;
  empty(off?: Off): Promise<void>;
  restore(): Promise<number>;
}

export function moverPool(prisma: PrismaClient, kind: 'rider' | 'driver'): MoverPool {
  const table = (kind === 'rider' ? prisma.rider : prisma.driver) as unknown as MoverTable;
  let before: Set<string> | null = null;
  const original = new Map<string, MoverState>();
  return {
    async begin() {
      const rows = await table.findMany({ select: { id: true } });
      before = new Set(rows.map((row) => row.id));
    },
    async empty(off = { isOnline: false, isAvailable: false }) {
      if (!before) throw new Error(`[AUD-G7-042] ${kind} pool: call begin() before the suite creates its own movers`);
      const fields = Object.keys(off) as Array<keyof MoverState>;
      const rows = await table.findMany({
        where: { OR: fields.map((field) => ({ [field]: true })) },
        select: { id: true, isOnline: true, isAvailable: true },
      });
      for (const row of rows) {
        if (before.has(row.id) && !original.has(row.id)) original.set(row.id, { isOnline: row.isOnline, isAvailable: row.isAvailable });
      }
      if (rows.length) await table.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: off });
    },
    async restore() {
      const groups = new Map<string, string[]>();
      for (const [id, state] of original) {
        const key = JSON.stringify(state);
        groups.set(key, [...(groups.get(key) ?? []), id]);
      }
      let restored = 0;
      for (const [key, ids] of groups) {
        restored += (await table.updateMany({ where: { id: { in: ids } }, data: JSON.parse(key) as MoverState })).count;
      }
      original.clear();
      return restored;
    },
  };
}
