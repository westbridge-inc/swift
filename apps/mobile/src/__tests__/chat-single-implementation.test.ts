import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * [R1 — the chat split-brain] One order, one conversation, one implementation.
 *
 * Two chat UIs were live at once. The customer on a delivery reached the new
 * `ConversationScreen`; the RIDER on that same order reached a legacy
 * `screens/shared/ChatScreen`, because `ActiveJobScreen` navigated to `'Chat'`
 * and both `CustomerStack` and `MoverStack` still routed it. Two people, one
 * order, two different chat screens.
 *
 * It was invisible to the test suite because both screens compiled perfectly
 * and each worked on its own. The break was in the ROUTING — which is exactly
 * the class this repo keeps finding (#807's SOS fan-out, #830's DLQ) and
 * exactly what a unit test never looks at.
 *
 * Note what the legacy screen was better at, because it decided the fix:
 * it accepted BOTH entry shapes (`roomId` directly, or `orderId` to resolve
 * from), and `ConversationScreen` accepted only `orderId`. Deleting it without
 * widening the survivor would have broken service-job chat, which passes a
 * `roomId`. So the capability was moved, not dropped — and the test below is
 * what stops a future "simplification" dropping it again.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments stripped — the standing hazard-matching rule. The
 *  comments below necessarily quote the banned route name. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const files = walk(SRC);
const allCode = files.map(code).join('\n');

describe('there is exactly one chat implementation', () => {
  it('the legacy shared ChatScreen is gone', () => {
    expect(existsSync(join(SRC, 'screens/shared/ChatScreen.tsx'))).toBe(false);
  });

  it('nothing imports it', () => {
    expect(allCode).not.toMatch(/from\s+['"][^'"]*shared\/ChatScreen['"]/);
  });

  it('no navigator registers a "Chat" route any more', () => {
    // The route existing at all is what let two implementations coexist.
    expect(allCode).not.toMatch(/name="Chat"/);
  });

  it('no screen navigates to a "Chat" route any more', () => {
    expect(allCode).not.toMatch(/navigate\(\s*['"]Chat['"]/);
    // Guard the guard: the file walk must actually be reading source.
    expect(allCode).toMatch(/navigate\(\s*['"]Conversation['"]/);
  });
});

describe('the customer and the rider on one order reach the SAME screen', () => {
  // The product assertion. This is the defect, stated as a test.
  it('the customer tracking screen opens Conversation', () => {
    const delivery = code(join(SRC, 'modules/orders/screens/DeliveryScreen.tsx'));
    expect(delivery).toMatch(/navigate\(\s*['"]Conversation['"]/);
  });

  it('the rider on that same job opens Conversation', () => {
    const activeJob = code(join(SRC, 'modules/mover/screens/ActiveJobScreen.tsx'));
    expect(activeJob).toMatch(/navigate\(\s*['"]Conversation['"]/);
  });
});

describe('every caller can actually reach the route it navigates to', () => {
  // A route name that is not registered in the caller's own stack is a button
  // that does nothing — and it looks like a route in the diff. MoverStack
  // registered ONLY the legacy `Chat`, so repointing the rider without
  // registering `Conversation` there would have silently broken it.
  const stacks = [
    { name: 'CustomerStack', file: join(SRC, 'navigation/CustomerStack.tsx') },
    { name: 'MoverStack', file: join(SRC, 'modules/mover/MoverStack.tsx') },
  ];

  for (const stack of stacks) {
    it(`${stack.name} registers Conversation`, () => {
      expect(code(stack.file)).toMatch(/name="Conversation"/);
    });
  }
});

describe('ConversationScreen still accepts BOTH entry shapes', () => {
  const conversation = code(join(SRC, 'modules/chat/screens/ConversationScreen.tsx'));

  it('resolves the room from an orderId', () => {
    expect(conversation).toMatch(/route\.params\?\.orderId/);
    expect(conversation).toMatch(/useChatRoom\(/);
  });

  it('accepts a roomId directly and skips the lookup', () => {
    // Service jobs create the room with the job, so they hold the id already.
    // Dropping this is how service-job chat breaks without any test going red —
    // which is why it is asserted rather than assumed.
    expect(conversation).toMatch(/route\.params\?\.roomId/);
    expect(conversation).toMatch(/paramRoomId\s*\?\s*undefined\s*:\s*orderId/);
    expect(conversation).toMatch(/paramRoomId\s*\?\?/);
  });

  it('does not show a room-resolution spinner when there is no room to resolve', () => {
    // With a direct roomId there is no lookup in flight; rendering its loading
    // state would be the UI describing work that is not happening.
    expect(conversation).toMatch(/!paramRoomId && room\.isLoading/);
  });
});
