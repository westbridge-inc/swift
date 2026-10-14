import { vi } from 'vitest';
import { Socket, type Server } from 'socket.io';

/** Real namespace/adapter recipient, with only the engine transport replaced.
 * Tests observe packets delivered to an authorized participant, rather than
 * treating an invocation of io.to(room) as a delivery receipt. */
export function orderSocketFixture(
  io: Server, order: { id: string; customerId: string; tenantId: string },
  received: (event: string, payload: unknown) => void,
  room = `order:${order.id}`,
): () => void {
  const namespace = io.of('/');
  const record = (packet: { data?: unknown[] }) => {
    if (typeof packet.data?.[0] === 'string') received(packet.data[0], packet.data[1]);
  };
  const client = {
    conn: { protocol: 4, remoteAddress: '127.0.0.1', readyState: 'open', transport: {} },
    _packet: record,
    writeToEngine: (packets: string[]) => {
      for (const encoded of packets) {
        const start = encoded.indexOf('[');
        if (start >= 0) record({ data: JSON.parse(encoded.slice(start)) as unknown[] });
      }
    },
  };
  const socket = new Socket(namespace, client as unknown as ConstructorParameters<typeof Socket>[1], {});
  socket.connected = true;
  socket.data = { userId: order.customerId, tenantId: order.tenantId, authorizationExpiresAtMs: Date.now() + 3_600_000 };
  namespace.sockets.set(socket.id, socket);
  socket.join([socket.id, room]);
  return () => { namespace.adapter.delAll(socket.id); namespace.sockets.delete(socket.id); socket.connected = false; };
}

/** Records, at the moment the audience gate snapshots `room` (its first step),
 * whether the mover's profile row is still row-locked by an open transaction.
 * A plain FOR UPDATE NOWAIT probe (autocommit, released at once) fails only
 * while another transaction holds a lock on that row. */
export function rowLockAtPublish(
  io: Server, prisma: { $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown> },
  room: string, table: 'riders' | 'drivers', id: string,
  beforeSnapshot?: () => Promise<unknown>,
): { locked: boolean[]; restore: () => void } {
  const locked: boolean[] = [];
  const originalIn = io.in.bind(io);
  const spy = vi.spyOn(io, 'in').mockImplementation(((target: string | string[]) => {
    const operator = originalIn(target);
    if (target === room) {
      const fetchSockets = operator.fetchSockets.bind(operator);
      Object.assign(operator, {
        fetchSockets: async () => {
          locked.push(await prisma.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE NOWAIT`, id).then(() => false, () => true));
          await beforeSnapshot?.();
          return fetchSockets();
        },
      });
    }
    return operator;
  }) as never);
  return { locked, restore: () => spy.mockRestore() };
}
