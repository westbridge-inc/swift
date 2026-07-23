import { describe, it, expect } from 'vitest';
import Redis from 'ioredis';
import { bullConnectionOpts } from '../jobs/queue';

// SWIFT-007 — BullMQ's connection must carry the WHOLE REDIS_URL, not just
// host+port. The old `{ host, port }` dropped the password/TLS (jobs never reach
// a managed Redis) and the db index (test jobs leaked onto db0). lazyConnect
// parses the URL into options WITHOUT opening a socket, so this is hermetic.

describe('bullConnectionOpts — the whole REDIS_URL reaches BullMQ [SWIFT-007]', () => {
  it('forwards auth + db, not just host/port', () => {
    const r = new Redis('redis://myuser:s3cret@redis.example:6390/7', { lazyConnect: true });
    const opts = bullConnectionOpts(r) as Record<string, unknown>;
    expect(opts['host']).toBe('redis.example');
    expect(opts['port']).toBe(6390);
    expect(opts['username']).toBe('myuser');
    expect(opts['password']).toBe('s3cret');
    expect(opts['db']).toBe(7);
    r.disconnect();
  });

  it('forwards TLS for a rediss:// (managed) URL', () => {
    const r = new Redis('rediss://:pw@secure.example:6380/0', { lazyConnect: true });
    const opts = bullConnectionOpts(r) as Record<string, unknown>;
    expect(opts['tls']).toBeDefined();
    expect(opts['password']).toBe('pw');
    r.disconnect();
  });

  it('omits auth for a local URL but keeps the db index (test isolation)', () => {
    const r = new Redis('redis://localhost:6382/15', { lazyConnect: true });
    const opts = bullConnectionOpts(r) as Record<string, unknown>;
    expect(opts['password']).toBeUndefined();
    expect(opts['tls']).toBeUndefined();
    expect(opts['db']).toBe(15); // NOT 0 — jobs land on the isolated db
    r.disconnect();
  });
});
