import net, { type AddressInfo } from 'node:net';

/**
 * A TCP proxy in front of the real test Redis, so a test can take Redis away
 * from one client without touching the Redis every other suite shares.
 * stop() is a crash (every connection reset, the port refuses), open() is the
 * restart on the same port, freeze() is a server that holds its connections
 * and answers nothing.
 */
export function redisProxy(targetUrl: string) {
  const target = new URL(targetUrl);
  const db = target.pathname;
  const pairs = new Set<{ client: net.Socket; upstream: net.Socket }>();
  let server: net.Server | undefined;
  let port = 0;
  return {
    get url() {
      return `redis://127.0.0.1:${port}${db}`;
    },
    async open() {
      const listening = net.createServer((client) => {
        const upstream = net.connect(Number(target.port), target.hostname);
        const pair = { client, upstream };
        pairs.add(pair);
        client.pipe(upstream);
        upstream.pipe(client);
        for (const side of [client, upstream]) {
          side.on('error', () => {});
          side.on('close', () => {
            client.destroy();
            upstream.destroy();
            pairs.delete(pair);
          });
        }
      });
      await new Promise<void>((resolve) => { listening.listen(port, '127.0.0.1', resolve); });
      port = (listening.address() as AddressInfo).port;
      server = listening;
    },
    async stop() {
      const listening = server;
      server = undefined;
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      if (listening) await new Promise((resolve) => { listening.close(resolve); });
    },
    freeze() {
      for (const { client, upstream } of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
  };
}
