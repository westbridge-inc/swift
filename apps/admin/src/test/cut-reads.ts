import { vi } from 'vitest';
import type { mockApi } from './test-utils';

/** A read that answered 200 and then died: the body never finishes, or it holds no list. Either way nothing was read. */
export const CUT_BODIES: Array<[string, () => Response]> = [
  ['a link that dies mid-body', () => new Response('{"success":true,"data":[{"id":"sos', { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ['a 200 with an empty object', () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ['a 200 with no list', () => new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ['a 200 with something that is not a list', () => new Response('{"success":true,"data":{"rows":[]}}', { status: 200, headers: { 'Content-Type': 'application/json' } })],
];
export function cutReads(fetchMock: ReturnType<typeof mockApi>, path: string, cut: () => Response) {
  const state = { on: false };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = await fetchMock(input, init);
    return state.on && new URL(String(input)).pathname === path ? cut() : reply;
  });
  return state;
}
