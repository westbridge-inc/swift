import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { NotificationService } from '../modules/notification/notification.service';
import { chatFixture } from './helpers/l05-chat-fixture';

let f: Awaited<ReturnType<typeof chatFixture>>;
let url: string;
const clients: Socket[] = [];
async function client(token: string) {
  const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('auth:ready', resolve); socket.once('connect_error', reject); });
  return socket;
}
beforeAll(async () => {
  f = await chatFixture();
  vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue(undefined as never);
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(f.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => { for (const c of clients) c.disconnect(); vi.restoreAllMocks(); await f?.close(); });

describe('subscribed sockets lose sensitive chat when assignment changes', () => {
  it('a former mover receives no message after reassignment and is evicted; current participants receive it', async () => {
    const old = await client(f.oldMover.token); const customer = await client(f.customer.token);
    const oldMessages: unknown[] = []; const currentMessages: unknown[] = [];
    old.on('chat:message', (m: unknown) => oldMessages.push(m));
    customer.on('chat:message', (m: unknown) => currentMessages.push(m));
    old.emit('chat:join', { roomId: f.room.id }); customer.emit('chat:join', { roomId: f.room.id });
    await expect.poll(async () => (await f.app.io.in(`chat:${f.room.id}`).fetchSockets()).length).toBe(2);
    // Positive control proves the old socket was actually subscribed.
    const first = await f.inject('POST', `/rooms/${f.room.id}/messages`, f.customer.token, { message: 'before replacement fixture' });
    expect(first.statusCode, first.body).toBe(200);
    await expect.poll(() => oldMessages.length).toBe(1);
    await f.revoke();
    const replacement = await client(f.newMover.token);
    replacement.on('chat:message', (m: unknown) => currentMessages.push(m));
    replacement.emit('chat:join', { roomId: f.room.id });
    await expect.poll(async () => (await f.app.io.in(`chat:${f.room.id}`).fetchSockets()).length).toBe(3);
    oldMessages.length = 0; currentMessages.length = 0;
    const res = await f.inject('POST', `/rooms/${f.room.id}/messages`, f.customer.token, { message: 'after replacement fixture' });
    expect(res.statusCode, res.body).toBe(200);
    await expect.poll(() => currentMessages.length).toBe(2);
    // A marker after the request orders the client's packet stream without sleeps.
    const marker = new Promise<void>((resolve) => old.once('test:drained', resolve));
    f.app.io.to(old.id!).emit('test:drained'); await marker;
    expect(oldMessages).toEqual([]);
    expect((await f.app.io.in(`chat:${f.room.id}`).fetchSockets()).map((s) => s.id)).not.toContain(old.id);
  });

  it('a former mover cannot send typing to the new participants through a retained subscription', async () => {
    // The retained subscription is seeded deliberately: a late join or a missed
    // eviction must not turn room membership back into authority.
    const old = await client(f.oldMover.token); const customer = await client(f.customer.token);
    await f.app.io.in(old.id!).socketsJoin(`chat:${f.room.id}`);
    customer.emit('chat:join', { roomId: f.room.id });
    await expect.poll(async () => (await f.app.io.in(`chat:${f.room.id}`).fetchSockets()).some((s) => s.id === customer.id)).toBe(true);
    const typing: unknown[] = []; customer.on('chat:typing', (m: unknown) => typing.push(m));
    old.emit('chat:typing', { roomId: f.room.id });
    // Receiving an explicit marker proves the old socket's packet was handled.
    const drained = new Promise<void>((resolve) => customer.once('test:drained', resolve));
    f.app.io.to(customer.id!).emit('test:drained'); await drained;
    await expect.poll(async () => (await f.app.io.in(`chat:${f.room.id}`).fetchSockets()).some((s) => s.id === old.id)).toBe(false);
    expect(typing).toEqual([]);
  });
});
