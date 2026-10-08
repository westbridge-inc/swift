import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatSendRefusal } from './sendRefusal';

// [L13 item 4] The server refuses chat text carrying phone numbers, outside
// links or abusive language (CHAT_CONTENT_NOT_ALLOWED). A refusal the person
// never sees reads as a network glitch and invites retyping the same thing, so
// the conversation screen must say why the message did not go.

const axiosRefusal = (code: string, status = 400) => ({
  isAxiosError: true,
  response: { status, data: { success: false, error: { code, message: 'server words', details: { reason: 'PHONE' } } } },
});

describe('chat send refusal', () => {
  it('explains a content refusal in plain words', () => {
    const text = chatSendRefusal(axiosRefusal('CHAT_CONTENT_NOT_ALLOWED'));
    expect(text).toMatch(/phone numbers, links or abusive language/i);
    expect(text).toMatch(/Swift/);
  });

  it.each([
    [axiosRefusal('ROOM_CLOSED', 409)],
    [axiosRefusal('INTERNAL_ERROR', 500)],
    [new Error('Network Error')],
    [undefined],
    [null],
  ])('leaves every other failure to the existing retry path (%#)', (error) => {
    expect(chatSendRefusal(error)).toBeNull();
  });

  it('the conversation screen shows the refusal when a send fails', () => {
    const src = readFileSync(path.join(__dirname, 'screens', 'ConversationScreen.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const onSend = /const onSend = \(\) => \{[\s\S]*?\n {2}\};/.exec(src)?.[0] ?? '';
    expect(onSend, 'onSend not found').not.toBe('');
    expect(onSend).toMatch(/onError: \(error\) => \{/);
    expect(onSend).toMatch(/const refusal = chatSendRefusal\(error\);/);
    expect(onSend).toMatch(/if \(refusal\) setNotice\(refusal\);/);
    expect(onSend).toMatch(/setDraft\(\(cur\) => \(cur\.trim\(\) \? cur : text\)\)/);
  });
});
