import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

// Reuse the API workspace's declared server dependency; no test-only install.
const apiRequire = createRequire(new URL('../../../api/package.json', import.meta.url));
const { Server } = apiRequire('socket.io');
const fx = vi.hoisted(() => ({ origin: '' }));
vi.mock('./api', () => ({ get API_URL() { return fx.origin; } }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => ({
  userId: 'socket-fixture', generation: 1, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
}) }));
import { connectSocket, disconnectSocket, getSocket } from './socket';

it('connects through real polling when the server refuses WebSockets', async () => {
  const http = createServer();
  const server = new Server(http, { transports: ['polling'] });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected an isolated TCP port');
  fx.origin = `http://127.0.0.1:${address.port}`;
  let transport = '';
  server.on('connection', (socket: { conn: { transport: { name: string } } }) => { transport = socket.conn.transport.name; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connected = new Promise<void>((resolve, reject) => {
      const socket = getSocket();
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      timer = setTimeout(() => reject(new Error('Polling did not connect')), 3000);
    });
    connectSocket();
    await connected;
    expect(transport).toBe('polling');
  } finally {
    if (timer) clearTimeout(timer);
    disconnectSocket();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});
