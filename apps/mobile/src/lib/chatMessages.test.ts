import { describe, expect, it } from 'vitest';
import { parseChatMessagesResponse } from './chatMessages';

describe('parseChatMessagesResponse', () => {
  it('preserves the message array and authoritative blocked state', () => {
    const messages = [{ id: 'message-1', message: 'hello' }];

    expect(parseChatMessagesResponse({
      data: { success: true, data: messages, contactBlocked: true },
    })).toEqual({ messages, contactBlocked: true });
  });

  it('keeps malformed metadata unknown so callers can fail closed', () => {
    expect(parseChatMessagesResponse({
      data: { data: [{ id: 'message-2' }], contactBlocked: 'true' },
    })).toEqual({ messages: [{ id: 'message-2' }], contactBlocked: null });
  });
});
