import { Socket, type Server } from 'socket.io';

/** Real namespace/adapter recipient, with only the engine transport replaced.
 * Tests observe packets delivered to an authorized customer, rather than
 * treating an invocation of io.to(orderRoom) as a delivery receipt. */
export function orderSocketFixture(
  io: Server, order: { id: string; customerId: string; tenantId: string },
  received: (event: string, payload: unknown) => void,
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
  socket.join([socket.id, `order:${order.id}`]);
  return () => { namespace.adapter.delAll(socket.id); namespace.sockets.delete(socket.id); socket.connected = false; };
}
