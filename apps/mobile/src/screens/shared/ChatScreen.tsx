import { useEffect, useState } from 'react';
import { View, FlatList, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Spinner, PressableScale } from '../../components/ui';
import { useAuthStore } from '../../stores/authStore';
import { useChatRoom, useChatMessages, useSendMessage } from '../../hooks/chat';
import { ContentSafetyActions } from '../../components/moderation/ContentSafetyActions';

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ChatScreen({ route, navigation }: any) {
  const orderId: string | undefined = route?.params?.orderId;
  // Service-job chats already carry their room id (created with the job) —
  // pass roomId directly and skip the order-room resolution.
  const paramRoomId: string | undefined = route?.params?.roomId;
  const title: string = route?.params?.title ?? 'Chat';
  const myId = useAuthStore((s) => s.user?.id);

  const roomQ = useChatRoom(paramRoomId ? undefined : orderId);
  const roomId: string | undefined = paramRoomId ?? (roomQ.data as any)?.id;
  const msgsQ = useChatMessages(roomId);
  const send = useSendMessage(roomId);
  const [text, setText] = useState('');
  const [locallyBlocked, setLocallyBlocked] = useState(false);
  const contactBlocked = locallyBlocked || msgsQ.contactBlocked;
  // A cached pre-block result is not fresh authority for a newly mounted room.
  const contactStatusPending = !!roomId && !msgsQ.isFetchedAfterMount;
  const contactStatusUnavailable = !!roomId
    && msgsQ.isFetchedAfterMount
    && (msgsQ.isError || !msgsQ.contactBlockedKnown);

  // Once the server confirms the block, the polling result becomes the sole
  // source of truth again so a later unblock can reopen the composer.
  useEffect(() => {
    if (msgsQ.contactBlocked) setLocallyBlocked(false);
  }, [msgsQ.contactBlocked]);

  // Newest-first for the inverted list (sticks to the bottom on new messages).
  const messages: any[] = (((msgsQ.data as any[]) ?? (roomQ.data as any)?.messages ?? []) as any[])
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const submit = () => {
    const m = text.trim();
    if (!m || !roomId || contactBlocked || contactStatusPending || contactStatusUnavailable) return;
    send.mutate(m, {
      onSuccess: () => setText(''),
      onError: (error) => {
        const code = (error as { response?: { data?: { error?: { code?: string } } } })
          ?.response?.data?.error?.code;
        if (code === 'USER_BLOCKED') {
          setLocallyBlocked(true);
          void msgsQ.refetch();
        }
      },
    });
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center border-b border-border-subtle px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={8}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Text className="ml-md text-base font-bold text-text-primary" numberOfLines={1}>
          {title}
        </Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={8}
      >
        {roomQ.isLoading ? (
          <View className="flex-1 items-center justify-center">
            <Spinner size="large" />
          </View>
        ) : (
          <FlatList
            inverted
            data={messages}
            keyExtractor={(m) => String(m.id)}
            contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => {
              const mine = item.senderId === myId;
              return (
                <View className={mine ? 'mb-sm items-end' : 'mb-sm items-start'}>
                  <View
                    className="rounded-2xl px-md py-sm"
                    style={[{ maxWidth: '80%' }, mine ? { backgroundColor: color.brand[500] } : { backgroundColor: color.surface.subtle }]}
                  >
                    <Text className={mine ? 'text-sm text-white' : 'text-sm text-text-primary'}>{item.message}</Text>
                  </View>
                  <Text className="mt-1 text-xs text-text-muted">{fmtTime(item.createdAt)}</Text>
                  {!mine && item.id ? (
                    <ContentSafetyActions
                      targetType="CHAT_MESSAGE"
                      targetId={item.id}
                      contentLabel="message"
                      onBlocked={() => {
                        setLocallyBlocked(true);
                        void msgsQ.refetch();
                      }}
                      style={{ marginTop: 6 }}
                    />
                  ) : null}
                </View>
              );
            }}
            ListEmptyComponent={<Text className="mt-2xl text-center text-sm text-text-muted">Say hello 👋</Text>}
          />
        )}

        <View className="flex-row items-center border-t border-border-subtle px-lg py-sm" style={{ gap: 8 }}>
          {contactStatusPending ? (
            <Text className="flex-1 text-sm text-text-muted">Checking chat availability…</Text>
          ) : contactStatusUnavailable ? (
            <>
              <Text className="flex-1 text-sm text-text-muted">Couldn’t confirm chat availability.</Text>
              <PressableScale onPress={() => { void msgsQ.refetch(); }} hitSlop={8}>
                <Text className="text-sm font-bold text-text-primary">Retry</Text>
              </PressableScale>
            </>
          ) : contactBlocked ? (
            <Text className="flex-1 text-sm text-text-muted">
              Contact is unavailable between these accounts.
            </Text>
          ) : <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Message…"
            placeholderTextColor={color.text.muted}
            className="flex-1 rounded-full border border-border-subtle bg-surface-base px-lg py-sm font-body text-base text-text-primary"
            onSubmitEditing={submit}
            returnKeyType="send"
          />}
          {!contactStatusPending && !contactStatusUnavailable && !contactBlocked ? <PressableScale
            onPress={submit}
            disabled={send.isPending || text.trim().length === 0}
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: text.trim().length === 0 ? color.border.subtle : color.brand[500] }}
          >
            <Feather name="send" size={18} color={color.white} />
          </PressableScale> : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
