import { describe, expect, it } from 'vitest';
import { Server, Socket } from 'socket.io';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the production location publication expression with the real
// Socket.IO in-memory adapter. The engine and database boundaries are explicit
// fixtures; HTTP/GPS persistence and Redis transport are tested separately.
async function scenario(lateJoin = false, unavailable = false) {
  const io = new Server(); const namespace = io.of('/');
  const captured = new Map<string, string[]>();
  const makeSocket = (userId: string, tenantId = 'fixture-tenant') => {
    const packets: string[] = []; captured.set(userId, packets);
    const client = {
      conn: { protocol: 4, remoteAddress: '127.0.0.1', readyState: 'open', transport: {} },
      _packet: (p: unknown) => packets.push(JSON.stringify(p)),
      writeToEngine: (p: string[]) => packets.push(...p),
    };
    const socket = new Socket(namespace, client as unknown as ConstructorParameters<typeof Socket>[1], {});
    socket.connected = true; socket.data = { userId, tenantId, authorizationExpiresAtMs: Date.now() + 60_000 };
    namespace.sockets.set(socket.id, socket); socket.join(socket.id);
    return socket;
  };
  const customer = makeSocket('fixture-customer'); const former = makeSocket('fixture-former');
  const replacement = makeSocket('fixture-replacement'); const foreign = makeSocket('fixture-foreign', 'foreign-tenant');
  const room = 'order:fixture-order';
  customer.join(room); replacement.join(room); foreign.join(room);
  if (!lateJoin) former.join(room);
  // A former socket whose delayed subscription joins after reassignment is
  // deliberately indistinguishable from a missed eviction at this boundary.
  if (lateJoin) former.join(room);
  const row = { id: 'fixture-order', tenantId: 'fixture-tenant', customerId: 'fixture-customer', rider: null, driver: { userId: 'fixture-replacement' }, vendor: null, holdExpiresAt: null, cancelledAt: null, paymentMethod: 'CASH' };
  const prisma = { order: { findUnique: async () => { if (unavailable) throw new Error('fixture read unavailable'); return row; } } };
  const file = join(__dirname, '../modules/driver/driver.routes.ts');
  const source = readFileSync(file, 'utf8'); const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const selected: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.arguments.some((a) => ts.isStringLiteral(a) && a.text === 'driver:location')) selected.push(n);
    ts.forEachChild(n, visit);
  };
  visit(ast); expect(selected).toHaveLength(1);
  let expression = selected[0]!.getText(ast);
  // The old source broadcasts directly; after the fix this exact production
  // expression calls the shared gate. Do not supply a permissive fake gate.
  let gate: unknown;
  if (expression.startsWith('emitToOrderRoom(')) {
    const modulePath = '../modules/order/' + 'order-room-emission.service';
    gate = (await import(modulePath)).emitToOrderRoom;
    expression = 'await ' + expression;
  }
  const js = ts.transpileModule(`globalThis.publish = async () => { ${expression}; };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { app: { io, prisma }, emitToOrderRoom: gate, authorized: { currentRideId: 'fixture-order' }, driver: { id: 'fixture-profile' }, latitude: 6.812345, longitude: -58.123456, heading: 15, etaMinutes: 4, Date, publish: undefined as unknown as () => Promise<void> };
  runInNewContext(js, context); await context.publish();
  const received = (userId: string) => captured.get(userId)!.filter((p) => p.includes('driver:location'));
  expect(received('fixture-customer')).toHaveLength(unavailable ? 0 : 1);
  expect(received('fixture-replacement')).toHaveLength(unavailable ? 0 : 1);
  expect(received('fixture-former')).toHaveLength(0);
  expect(received('fixture-foreign')).toHaveLength(0);
  if (!unavailable) expect(former.rooms.has(room)).toBe(false);
  namespace.sockets.clear();
}

describe('order location uses current authority at publication', () => {
  it('a retained former participant receives no replacement GPS', () => scenario());
  it('a delayed stale join cannot restore location access', () => scenario(true));
  it('an unavailable authority store emits no private event', () => scenario(false, true));
});
