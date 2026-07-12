/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { useChatMessages, useChatRoom, useSendMessage } from '../../../hooks/chat';
import { useAuthStore } from '../../../stores/authStore';
import { ErrorState, Header, LoadingBlock, Screen, T } from '../../../kit';

const GUTTER = space['2xl'];

// Kit Conversation (41–42): bubbles + rounded input bar with a brand send
// circle. Backed by the order-scoped chat room, 4s polling.
export function ConversationScreen() {
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const orderId: string = route.params?.orderId;
  const title: string = route.params?.title ?? 'Chat';
  const user = useAuthStore((s) => s.user);

  const room = useChatRoom(orderId);
  const roomId = (room.data as any)?.id;
  const messages = useChatMessages(roomId);
  const send = useSendMessage(roomId);
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  const msgs: any[] = Array.isArray(messages.data) ? messages.data : ((messages.data as any)?.messages ?? []);

  useEffect(() => {
    if (msgs.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
  }, [msgs.length]);

  const onSend = () => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft('');
    send.mutate(text);
  };

  return (
    <Screen>
      <Header title={title} />
      {room.isLoading ? (
        <LoadingBlock />
      ) : room.isError || !roomId ? (
        <ErrorState
          onRetry={() => room.refetch()}
          message="Chat opens once a rider is on your order."
        />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            data={msgs}
            keyExtractor={(m, i) => m.id ?? String(i)}
            contentContainerStyle={{ padding: GUTTER, gap: space.md, flexGrow: 1 }}
            ListEmptyComponent={
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <T variant="label" tone="muted">
                  Say hi — messages stay on this order.
                </T>
              </View>
            }
            renderItem={({ item: m }) => {
              const mine = m.senderId === user?.id;
              return (
                <View
                  style={{
                    alignSelf: mine ? 'flex-end' : 'flex-start',
                    maxWidth: '78%',
                    backgroundColor: mine ? color.brand[500] : color.surface.base,
                    borderRadius: radius.lg,
                    borderBottomRightRadius: mine ? 4 : radius.lg,
                    borderBottomLeftRadius: mine ? radius.lg : 4,
                    paddingHorizontal: space.lg,
                    paddingVertical: space.md,
                    borderWidth: mine ? 0 : 1,
                    borderColor: color.border.subtle,
                  }}
                >
                  <T variant="body" style={{ color: mine ? color.white : color.text.primary }}>
                    {m.message ?? m.text}
                  </T>
                  <T
                    variant="caption"
                    style={{
                      color: mine ? 'rgba(255,255,255,0.7)' : color.text.muted,
                      marginTop: 3,
                      alignSelf: 'flex-end',
                    }}
                  >
                    {m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}
                  </T>
                </View>
              );
            }}
          />

          {/* Input bar */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              paddingHorizontal: GUTTER,
              paddingTop: space.md,
              paddingBottom: insets.bottom + space.md,
              backgroundColor: color.surface.base,
              borderTopWidth: 1,
              borderTopColor: color.border.subtle,
            }}
          >
            <View
              style={{
                flex: 1,
                height: 48,
                borderRadius: 9999,
                borderWidth: 1,
                borderColor: color.border.subtle,
                backgroundColor: color.surface.subtle,
                paddingHorizontal: space.xl,
                justifyContent: 'center',
              }}
            >
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Type a message…"
                placeholderTextColor={color.text.muted}
                style={{ fontFamily: 'Inter', fontSize: 15, color: color.text.primary }}
                onSubmitEditing={onSend}
                returnKeyType="send"
              />
            </View>
            <Pressable onPress={onSend} disabled={!draft.trim() || send.isPending}>
              {({ pressed }) => (
                <View
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    backgroundColor: !draft.trim() ? color.brand[200] : pressed ? color.brand[600] : color.brand[500],
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Feather name="send" size={18} color={color.white} />
                </View>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </Screen>
  );
}
