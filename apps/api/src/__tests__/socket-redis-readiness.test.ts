import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('production socket Redis readiness', () => {
  it('does not complete plugin readiness before both adapter subscriptions are acknowledged', async () => {
    // [F-027-15] A production boot must also name a real push provider —
    // getPushProvider now refuses the in-memory one outside dev/test, so a
    // production-simulating test that omits it is simulating a boot the
    // product would (correctly) refuse.
    process.env['NODE_ENV'] = 'production';
    process.env['PUSH_PROVIDER'] = 'expo';
    process.env['CORS_ORIGIN'] = 'http://127.0.0.1';
    process.env['REDIS_URL'] ||= 'redis://localhost:6382';
    process.env['JWT_SECRET'] ||= 'socket-readiness-test-secret-at-least-32-characters';

    const patternEntered = deferred();
    const channelsEntered = deferred();
    const releasePattern = deferred();
    const releaseChannels = deferred();
    const originalPsubscribe = Redis.prototype.psubscribe;
    const originalSubscribe = Redis.prototype.subscribe;
    const originalDuplicate = Redis.prototype.duplicate;
    const adapterClients: Redis[] = [];
    const duplicateSpy = vi.spyOn(Redis.prototype, 'duplicate').mockImplementation(function (
      this: Redis,
      ...args: Parameters<Redis['duplicate']>
    ) {
      const client = Reflect.apply(originalDuplicate, this, args);
      adapterClients.push(client);
      return client;
    });
    const psubscribeSpy = vi.spyOn(Redis.prototype, 'psubscribe').mockImplementation(function (
      this: Redis,
      ...args: Parameters<Redis['psubscribe']>
    ) {
      patternEntered.resolve();
      return releasePattern.promise.then(() => Reflect.apply(originalPsubscribe, this, args));
    });
    const subscribeSpy = vi.spyOn(Redis.prototype, 'subscribe').mockImplementation(function (
      this: Redis,
      ...args: Parameters<Redis['subscribe']>
    ) {
      channelsEntered.resolve();
      return releaseChannels.promise.then(() => Reflect.apply(originalSubscribe, this, args));
    });

    const app = Fastify({ logger: false });
    let ready = false;
    let registration: Promise<void> | undefined;
    try {
      await app.register(redisPlugin);
      await app.register(authPlugin);
      app.register(socketPlugin);
      registration = Promise.resolve(app.ready()).then(() => { ready = true; });

      await Promise.all([patternEntered.promise, channelsEntered.promise]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(ready).toBe(false);

      releasePattern.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(ready).toBe(false);

      releaseChannels.resolve();
      await registration;
      expect(ready).toBe(true);
      expect(app.checkSocketAdapterReady()).toBe(true);

      // Runtime adapter failure must remove this node from load-balancer
      // readiness even while the primary Redis client remains healthy.
      adapterClients[0]!.emit('error', new Error('forced adapter failure'));
      expect(app.checkSocketAdapterReady()).toBe(false);
    } finally {
      releasePattern.resolve();
      releaseChannels.resolve();
      await registration?.catch(() => {});
      await app.close().catch(() => {});
      psubscribeSpy.mockRestore();
      subscribeSpy.mockRestore();
      duplicateSpy.mockRestore();
    }
  });

  it('bounds duplicate-client connectivity and closes partial startup resources', async () => {
    // [F-027-15] A production boot must also name a real push provider —
    // getPushProvider now refuses the in-memory one outside dev/test, so a
    // production-simulating test that omits it is simulating a boot the
    // product would (correctly) refuse.
    process.env['NODE_ENV'] = 'production';
    process.env['PUSH_PROVIDER'] = 'expo';
    process.env['CORS_ORIGIN'] = 'http://127.0.0.1';
    process.env['REDIS_URL'] ||= 'redis://localhost:6382';
    process.env['JWT_SECRET'] ||= 'socket-readiness-test-secret-at-least-32-characters';
    const previousStartupTimeout = process.env['SOCKET_REDIS_STARTUP_TIMEOUT_MS'];
    const previousShutdownTimeout = process.env['SOCKET_SHUTDOWN_TIMEOUT_MS'];
    process.env['SOCKET_REDIS_STARTUP_TIMEOUT_MS'] = '50';
    process.env['SOCKET_SHUTDOWN_TIMEOUT_MS'] = '500';

    const app = Fastify({ logger: false });
    const originalDuplicate = Redis.prototype.duplicate;
    const originalPing = Redis.prototype.ping;
    const adapterClients: Redis[] = [];
    let primaryClient: Redis | undefined;
    const duplicateSpy = vi.spyOn(Redis.prototype, 'duplicate').mockImplementation(function (
      this: Redis,
      ...args: Parameters<Redis['duplicate']>
    ) {
      const client = Reflect.apply(originalDuplicate, this, args);
      adapterClients.push(client);
      return client;
    });
    try {
      await app.register(redisPlugin);
      await app.register(authPlugin);
      primaryClient = app.redis;
      const pingSpy = vi.spyOn(Redis.prototype, 'ping').mockImplementation(function (
        this: Redis,
        ...args: Parameters<Redis['ping']>
      ) {
        if (this === primaryClient) return Reflect.apply(originalPing, this, args);
        return new Promise<never>(() => {});
      });
      try {
        app.register(socketPlugin);
        await expect(app.ready()).rejects.toThrow('Socket adapter startup timed out after 50ms');
        expect(adapterClients).toHaveLength(2);
        await vi.waitFor(() => {
          expect(adapterClients.every((client) => client.status === 'end')).toBe(true);
        });
      } finally {
        pingSpy.mockRestore();
      }
    } finally {
      await app.close().catch(() => {});
      duplicateSpy.mockRestore();
      if (previousStartupTimeout === undefined) {
        delete process.env['SOCKET_REDIS_STARTUP_TIMEOUT_MS'];
      } else {
        process.env['SOCKET_REDIS_STARTUP_TIMEOUT_MS'] = previousStartupTimeout;
      }
      if (previousShutdownTimeout === undefined) {
        delete process.env['SOCKET_SHUTDOWN_TIMEOUT_MS'];
      } else {
        process.env['SOCKET_SHUTDOWN_TIMEOUT_MS'] = previousShutdownTimeout;
      }
    }
  });
});
