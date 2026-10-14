import { expect, it, vi } from 'vitest';
import { bindChatRoom } from './chatRoomSubscription';
it('refreshes only the live room, rejoins and detaches callbacks', () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const socket = { emit: vi.fn(), on: vi.fn((event, cb) => listeners.set(event, cb)), off: vi.fn((event) => listeners.delete(event)) };
  const refresh = vi.fn();
  let owned = true;
  const stop = bindChatRoom(socket, 'room-fixture', () => owned, refresh);
  expect(socket.emit).toHaveBeenCalledWith('chat:join', { roomId: 'room-fixture' });
  listeners.get('chat:message')!({ roomId: 'other-room' });
  expect(refresh).not.toHaveBeenCalled();
  listeners.get('chat:message')!({ roomId: 'room-fixture' });
  expect(refresh).toHaveBeenCalledTimes(1);
  listeners.get('connect')!();
  expect(socket.emit).toHaveBeenCalledTimes(2);
  owned = false;
  listeners.get('connect')!();
  listeners.get('chat:message')!({ roomId: 'room-fixture' });
  expect(socket.emit).toHaveBeenCalledTimes(2);
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
  expect(listeners.size).toBe(0);
  expect(socket.emit).toHaveBeenCalledTimes(2);
});
it('leaves when the same session closes the screen', () => {
  const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  bindChatRoom(socket, 'room-fixture', () => true, vi.fn())();
  expect(socket.emit).toHaveBeenLastCalledWith('chat:leave', { roomId: 'room-fixture' });
});
