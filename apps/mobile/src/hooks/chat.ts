import { useEffect } from 'react';
import { connectSocket, getSocket } from '../services/socket';
import { getAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import { samePrincipalBoundary } from '../lib/authSession';
import { bindChatRoom } from '../lib/chatRoomSubscription';
import { adaptivePollInterval } from '../lib/adaptivePolling';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatApi } from '../services/api';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

/** Get (or create) the chat room for an order. The room carries participants
 *  and the initial message page. */
export function useChatRoom(orderId?: string) {
  return useQuery({
    queryKey: ['chat', 'room', orderId],
    queryFn: () => unwrap(chatApi.room(orderId!)),
    enabled: !!orderId,
  });
}

/** Socket messages refresh promptly; polling is the reconnect safety net. */
export function useChatMessages(roomId?: string) {
  const qc = useQueryClient();
  const generation = useAuthStore((state) => state.sessionGeneration);
  useEffect(() => {
    const owner = getAuthSessionSnapshot();
    if (!roomId || !owner) return;
    connectSocket();
    return bindChatRoom(getSocket(), roomId,
      () => samePrincipalBoundary(owner, getAuthSessionSnapshot()),
      () => qc.invalidateQueries({ queryKey: ['chat', 'messages', roomId] }));
  }, [roomId, generation, qc]);
  return useQuery({
    queryKey: ['chat', 'messages', roomId],
    queryFn: () => unwrap<any[]>(chatApi.messages(roomId!)),
    enabled: !!roomId,
    refetchInterval: () => adaptivePollInterval(4000, 15000),
  });
}

export function useSendMessage(roomId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => unwrap(chatApi.send(roomId!, message)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat', 'messages', roomId] }),
  });
}
