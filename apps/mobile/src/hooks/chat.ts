import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatApi } from '../services/api';
import { parseChatMessagesResponse } from '../lib/chatMessages';

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

/** Poll the message list (no socket dependency); 4s is plenty for a 1:1 thread. */
export function useChatMessages(roomId?: string) {
  const query = useQuery({
    queryKey: ['chat', 'messages', roomId],
    queryFn: async () => parseChatMessagesResponse<any>(await chatApi.messages(roomId!)),
    enabled: !!roomId,
    refetchInterval: 4000,
  });

  return {
    ...query,
    // Preserve the existing hook contract for both chat screens.
    data: query.data?.messages,
    contactBlocked: query.data?.contactBlocked === true,
    contactBlockedKnown: typeof query.data?.contactBlocked === 'boolean',
  };
}

export function useSendMessage(roomId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => unwrap(chatApi.send(roomId!, message)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat', 'messages', roomId] }),
  });
}
