/**
 * A Redis restart closes the socket adapter's two connections. Before: the
 * instance withdrew its readiness for good, /ready stayed false until a person
 * restarted the API, and emits between API and worker stopped crossing. These
 * run the production adapter against real Redis, through a proxy that can take
 * Redis away.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { redisProxy } from './helpers/redis-proxy';

const realRedisUrl = process.env['REDIS_URL'] || 'redis://localhost:6382';
const previousNodeEnv = process.env['NODE_ENV'];
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

let nodes: FastifyInstance[] = [];
let proxy: ReturnType<typeof redisProxy> | undefined;

async function startNode(url: string): Promise<FastifyInstance> {
  process.env['REDIS_URL'] = url;
  const app = Fastify({ logger: false });
  nodes.push(app);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  return app;
}

type AdapterWithClients = { pubClient: Redis; subClient: Redis };

function adapterClientsBoth(app: FastifyInstance): AdapterWithClients {
  return app.io.of('/').adapter as unknown as AdapterWithClients;
}

function adapterClientsOf(app: FastifyInstance): Redis[] {
  const { pubClient, subClient } = adapterClientsBoth(app);
  return [pubClient, subClient];
}

async function serverSideMessageArrives(from: FastifyInstance, to: FastifyInstance, withinMs: number) {
  const received = new Promise<void>((resolve) => {
    to.io.once('reconnect-probe', () => resolve());
  });
  from.io.serverSideEmit('reconnect-probe');
  return Promise.race([received.then(() => true), sleep(withinMs).then(() => false)]);
}

beforeAll(() => {
  process.env['NODE_ENV'] = 'production';
  process.env['PUSH_PROVIDER'] = 'expo';
  process.env['CORS_ORIGIN'] = 'http://127.0.0.1';
  process.env['JWT_SECRET'] ||= 'socket-reconnect-test-secret-at-least-32-characters';
});

afterEach(async () => {
  await Promise.allSettled(nodes.map((node) => node.close()));
  nodes = [];
  await proxy?.stop();
  proxy = undefined;
  process.env['REDIS_URL'] = realRedisUrl;
});

afterAll(() => {
  process.env['NODE_ENV'] = previousNodeEnv;
});

describe('the socket adapter through a Redis restart', () => {
  it('withdraws readiness while Redis is gone, then comes back by itself and carries a message between nodes', async () => {
    proxy = redisProxy(realRedisUrl);
    await proxy.open();
    const behindProxy = await startNode(proxy.url);
    const other = await startNode(realRedisUrl);
    expect(behindProxy.checkSocketAdapterReady()).toBe(true);
    expect(await serverSideMessageArrives(behindProxy, other, 2_000)).toBe(true);
    expect(await serverSideMessageArrives(other, behindProxy, 2_000)).toBe(true);

    await proxy.stop();
    await vi.waitFor(() => { expect(behindProxy.checkSocketAdapterReady()).toBe(false); });
    await sleep(1_500);
    expect(behindProxy.checkSocketAdapterReady()).toBe(false);

    await proxy.open();
    await vi.waitFor(() => { expect(behindProxy.checkSocketAdapterReady()).toBe(true); }, { timeout: 4_000, interval: 50 });
    // Both directions: publish on the pub connection, delivery on the re-subscribed sub connection.
    expect(await serverSideMessageArrives(behindProxy, other, 2_000)).toBe(true);
    expect(await serverSideMessageArrives(other, behindProxy, 2_000)).toBe(true);
  }, 20_000);

  it('stays withdrawn when the server refuses a re-subscribe', async () => {
    proxy = redisProxy(realRedisUrl);
    await proxy.open();
    const app = await startNode(proxy.url);
    expect(app.checkSocketAdapterReady()).toBe(true);

    await proxy.stop();
    await vi.waitFor(() => { expect(app.checkSocketAdapterReady()).toBe(false); });
    const realSend = Redis.prototype.sendCommand;
    const send = vi.spyOn(Redis.prototype, 'sendCommand').mockImplementation(function (
      this: Redis,
      ...args: Parameters<Redis['sendCommand']>
    ) {
      const [command] = args;
      if (command.name === 'psubscribe') {
        command.reject(new Error('NOPERM re-subscribe refused'));
        return command.promise;
      }
      return Reflect.apply(realSend, this, args);
    });
    try {
      await proxy.open();
      await sleep(2_000);
      expect(app.redis.status).toBe('ready');
      expect(adapterClientsOf(app).every((client) => client.status === 'ready')).toBe(true);
      expect(app.checkSocketAdapterReady()).toBe(false);
    } finally {
      send.mockRestore();
    }

    // A new connection re-sends everything: a server that stopped refusing is believed again.
    await proxy.stop();
    await proxy.open();
    await vi.waitFor(() => { expect(app.checkSocketAdapterReady()).toBe(true); }, { timeout: 4_000, interval: 50 });
  }, 15_000);

  it('does not call the instance ready until the server has answered behind the re-subscribes', async () => {
    proxy = redisProxy(realRedisUrl);
    await proxy.open();
    const app = await startNode(proxy.url);
    const { subClient } = adapterClientsBoth(app);

    await proxy.stop();
    await vi.waitFor(() => { expect(app.checkSocketAdapterReady()).toBe(false); });
    const realSend = Redis.prototype.sendCommand;
    const held: Array<() => void> = [];
    const send = vi.spyOn(Redis.prototype, 'sendCommand').mockImplementation(function (
      this: Redis,
      ...args: Parameters<Redis['sendCommand']>
    ) {
      const [command] = args;
      if (this === subClient && command.name === 'ping') {
        held.push(() => { void Reflect.apply(realSend, this, args); });
        return command.promise;
      }
      return Reflect.apply(realSend, this, args);
    });
    try {
      await proxy.open();
      await vi.waitFor(() => { expect(held.length).toBeGreaterThan(0); }, { timeout: 4_000, interval: 25 });
      await sleep(200);
      expect(app.checkSocketAdapterReady()).toBe(false);

      for (const release of held.splice(0)) release();
      await vi.waitFor(() => { expect(app.checkSocketAdapterReady()).toBe(true); });
    } finally {
      send.mockRestore();
    }
  }, 15_000);

  it('a command lost to the outage itself is not a refusal: readiness still comes back', async () => {
    proxy = redisProxy(realRedisUrl);
    await proxy.open();
    const app = await startNode(proxy.url);
    const { subClient } = adapterClientsBoth(app);

    await proxy.stop();
    await expect(subClient.subscribe('reconnect-probe-lost')).rejects.toThrow();
    await proxy.open();
    await vi.waitFor(() => { expect(app.checkSocketAdapterReady()).toBe(true); }, { timeout: 4_000, interval: 50 });
  }, 15_000);

  it('a publish the live server refused withdraws readiness, and only that connection needs to come back', async () => {
    proxy = redisProxy(realRedisUrl);
    await proxy.open();
    const app = await startNode(proxy.url);
    const { pubClient } = adapterClientsBoth(app);
    const realSend = Redis.prototype.sendCommand;
    const send = vi.spyOn(Redis.prototype, 'sendCommand').mockImplementation(function (
      this: Redis,
      ...args: Parameters<Redis['sendCommand']>
    ) {
      const [command] = args;
      if (command.name === 'publish') {
        command.reject(new Error('OOM publish refused'));
        return command.promise;
      }
      return Reflect.apply(realSend, this, args);
    });
    try {
      app.io.serverSideEmit('reconnect-probe');
      await vi.waitFor(() => { expect(app.checkSocketAdapterReady()).toBe(false); });
    } finally {
      send.mockRestore();
    }

    pubClient.disconnect(true);
    await vi.waitFor(() => { expect(app.checkSocketAdapterReady()).toBe(true); }, { timeout: 4_000, interval: 50 });
  }, 15_000);

  it('shuts down at once with Redis down, even with a publish still queued, and reports no failure', async () => {
    proxy = redisProxy(realRedisUrl);
    await proxy.open();
    const app = await startNode(proxy.url);
    await proxy.stop();
    await vi.waitFor(() => { expect(app.checkSocketAdapterReady()).toBe(false); });
    app.io.serverSideEmit('reconnect-probe');

    const startedAt = Date.now();
    await expect(app.close()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  }, 10_000);
});
