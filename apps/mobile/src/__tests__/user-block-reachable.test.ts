import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// [STORE-002] THE SAME CLASS OF DEFECT AS S15, CAUGHT BEFORE IT SHIPPED.
//
// App Store Guideline 1.2 and Google Play's UGC policy require FOUR things of
// an app carrying user-generated content: a content filter, a way to report, a
// way to BLOCK, and a published contact. Swift had three. The audit that found
// it also found that the one it did have was barely connected: the report API
// accepts five target types and exactly one screen in the whole app called it.
//
// That is the shape this programme keeps meeting — every layer passing its own
// tests while the chain between them is broken. A unit test on the block
// service proves the service; it cannot prove a person can reach it. So this
// asserts the CHAIN: route has a client caller, caller has a hook, hook has a
// screen, screen has a stack entry, and the stack entry has a door someone can
// actually find. The way this regresses is deletion by tidying, not a wrong
// line of code.
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/** Comment text is prose, not wiring. A gate that matches its own explanation
 *  passes while the code it grades is gone — this bit the programme four times
 *  in one session, so every assertion below reads stripped source. */
function stripComments(src: string): string {
  const out = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (out.trim().length === 0) throw new Error('stripComments returned empty — the stripper is broken, not the source');
  return out;
}

describe('the blocking chain is connected end to end [STORE-002]', () => {
  it('every block route has a caller in the API client', () => {
    const api = stripComments(read('services/api.ts'));
    const routes = ["api.get('/blocks')", "api.post('/blocks'", 'api.put(`/blocks/'];
    const missing = routes.filter((r) => !api.includes(r));
    expect(missing, `no client caller for: ${missing.join(', ')}`).toEqual([]);
  });

  it('the client callers have hooks — an api helper nothing imports is dead code', () => {
    const hooks = stripComments(read('hooks/customer.ts'));
    for (const hook of ['useBlockedUsers', 'useBlockUser', 'useUnblockUser']) {
      expect(hooks, `missing hook ${hook}`).toContain(`export function ${hook}`);
    }
    expect(hooks).toContain('moderationApi.listBlocks');
    expect(hooks).toContain('moderationApi.block');
    expect(hooks).toContain('moderationApi.unblock');
  });

  it('the screen is registered on the stack — an unrouted screen is unreachable', () => {
    const stack = stripComments(read('navigation/CustomerStack.tsx'));
    expect(stack).toContain('BlockedUsersScreen');
    expect(stack).toContain('name="BlockedUsers"');
  });

  it('the stack entry has a door in Profile — a route nothing navigates to is a route nobody finds', () => {
    const profile = stripComments(read('modules/profile/screens/ProfileScreen.tsx'));
    expect(profile).toContain("navigate('BlockedUsers')");
  });

  it('blocking is offered where harassment happens, not only in settings', () => {
    // The whole point of the control. A block list a person can only reach
    // from Profile is a place to UNDO a block; the place to PLACE one is the
    // conversation they are trying to get out of.
    const convo = stripComments(read('modules/chat/screens/ConversationScreen.tsx'));
    // The CALL, not the identifier. `toContain('useBlockUser')` is satisfied by
    // any name that merely starts with it — a renamed import passes while the
    // screen no longer blocks anyone. Caught by mutation, which is the only
    // reason this line reads the way it does.
    expect(convo).toMatch(/=\s*useBlockUser\(\)/);
    expect(convo).toMatch(/=\s*useReportContent\(\)/);
    expect(convo).toMatch(/blockUser\.mutate\(/);
    // Both legs Apple asks for, on the surface that carries the UGC.
    expect(convo).toContain('CHAT_MESSAGE');
  });

  it('the screen can undo a block — a control with no way back is a trap', () => {
    const screen = stripComments(read('modules/safety/screens/BlockedUsersScreen.tsx'));
    expect(screen).toContain('useUnblockUser');
    expect(screen).toContain('Unblock');
  });

  it('the block confirmation states what a block DOES, and does not overclaim', () => {
    const convo = read('modules/chat/screens/ConversationScreen.tsx');
    // The two consequences that are true, named in the copy: contact stops,
    // and dispatch stops pairing them.
    expect(convo).toMatch(/not be able to message you/i);
    expect(convo).toMatch(/not match you with them/i);
    // And the one that is NOT true. Blocking does not delete history — the
    // server keeps the transcript readable on purpose, and copy implying
    // otherwise would be the UI lying at the worst possible moment.
    expect(convo).toMatch(/already sent stay/i);
  });
});
