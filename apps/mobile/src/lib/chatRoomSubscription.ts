type RoomSocket = {
  emit: (event: string, payload: { roomId: string }) => unknown;
  on: (event: string, callback: (payload?: { roomId?: string }) => void) => unknown;
  off: (event: string, callback: (payload?: { roomId?: string }) => void) => unknown;
};
/** Every reconnect creates new server rooms; never rejoin an expired session. */
export function bindChatRoom(socket: RoomSocket, roomId: string, ownsSession: () => boolean, refresh: () => unknown): () => void {
  const join = () => { if (ownsSession()) socket.emit('chat:join', { roomId }); };
  const onMessage = (payload?: { roomId?: string }) => {
    if (ownsSession() && payload?.roomId === roomId) refresh();
  };
  join();
  socket.on('connect', join);
  socket.on('chat:message', onMessage);
  return () => {
    socket.off('connect', join);
    socket.off('chat:message', onMessage);
    if (ownsSession()) socket.emit('chat:leave', { roomId });
  };
}
