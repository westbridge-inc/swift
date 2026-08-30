/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withAlpha, color, font, fontSize, radius, space } from '@swift/ui';
import { useChatMessages, useChatRoom, useSendMessage } from '../../../hooks/chat';
import { useAuthStore } from '../../../stores/authStore';
import { useBlockUser, useReportContent } from '../../../hooks/customer';
import { ActionSheet, CircleChip, ConfirmDialog, ErrorState, Header, LoadingBlock, Screen, T } from '../../../kit';

const GUTTER = space['2xl'];

// Kit Conversation (41–42): bubbles + rounded input bar with a brand send
// circle. Backed by the order-scoped chat room, 4s polling.
export function ConversationScreen() {
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const orderId: string | undefined = route.params?.orderId;
  const title: string = route.params?.title ?? 'Chat';
  const user = useAuthStore((s) => s.user);

  // [R1] Two entry shapes, one screen. An ORDER-scoped caller passes orderId
  // and the room is resolved from it; a caller that already holds the room —
  // service jobs, whose chat room is created with the job — passes roomId and
  // skips the lookup. The deleted legacy ChatScreen was the only screen that
  // handled both, which is why two stacks were still routing it; this is that
  // capability, moved rather than lost.
  const paramRoomId: string | undefined = route.params?.roomId;
  const room = useChatRoom(paramRoomId ? undefined : orderId);
  const roomId: string | undefined = paramRoomId ?? (room.data as any)?.id;
  const messages = useChatMessages(roomId);
  const send = useSendMessage(roomId);
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  const msgs: any[] = Array.isArray(messages.data) ? messages.data : ((messages.data as any)?.messages ?? []);

  // [STORE-002] Report and block, from the place a person actually needs them.
  //
  // Apple 1.2 and Google's UGC policy require both, and until now the app
  // offered reporting on ONE screen (a storefront) and blocking nowhere at
  // all — while the surface where somebody is actually harassed is this one.
  //
  // WHO gets blocked has to be a real counterparty, never a guess. The room
  // payload names the participants when the screen was entered by orderId; a
  // roomId entry (service jobs) skips that fetch, so fall back to the last
  // person who actually spoke here. If neither identifies anyone — an empty
  // thread opened by roomId — the menu is not offered at all, because an
  // action that cannot say who it will block must not pretend it can.
  const participants: any[] = (room.data as any)?.participants ?? [];
  const fromRoom = participants.find((p) => (p.userId ?? p.user?.id) !== user?.id);
  const fromMessages = msgs.find((m) => m.senderId && m.senderId !== user?.id);
  const counterpartId: string | undefined =
    (fromRoom?.userId ?? fromRoom?.user?.id) ?? fromMessages?.senderId;
  const counterpartName: string = fromRoom?.user?.firstName ?? (title !== 'Chat' ? title : 'this person');

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const blockUser = useBlockUser();
  const reportContent = useReportContent();

  useEffect(() => {
    if (msgs.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
  }, [msgs.length]);

  const onSend = () => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft('');
    // [WR-035] A failed send restores the draft (unless they typed anew) —
    // clearing it optimistically must never eat the message.
    send.mutate(text, { onError: () => setDraft((cur) => (cur.trim() ? cur : text)) });
  };

  return (
    <Screen>
      <Header
        title={title}
        right={
          counterpartId ? (
            <CircleChip icon="more-vertical" label="Safety options" onPress={() => setMenuOpen(true)} />
          ) : undefined
        }
      />
      {!paramRoomId && room.isLoading ? (
        <LoadingBlock />
      ) : (!paramRoomId && room.isError) || !roomId ? (
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
              messages.isError ? (
                // [WR-035] A failed history load is not an empty thread.
                <ErrorState onRetry={() => messages.refetch()} message="Couldn't load this conversation." />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <T variant="label" tone="muted">
                    Say hi — messages stay on this order.
                  </T>
                </View>
              )
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
                      color: mine ? withAlpha(color.white, 0.7) : color.text.muted,
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
                // [Wave 3] Tokens, not raw font literals.
                style={{ fontFamily: font.body, fontSize: fontSize.base, color: color.text.primary }}
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

      <ActionSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={counterpartName === 'this person' ? 'This conversation' : counterpartName}
        actions={[
          {
            label: 'Report this conversation',
            icon: 'flag-outline',
            onPress: () => {
              setMenuOpen(false);
              if (!counterpartId) return;
              // The most recent message from them is the thing being reported.
              // Falling back to the person means a report is still filed when
              // the objectionable part was a profile or a name rather than a
              // message — never a silent no-op.
              const theirLast = msgs.filter((m) => m.senderId === counterpartId).slice(-1)[0];
              reportContent.mutate(
                theirLast?.id
                  ? { targetType: 'CHAT_MESSAGE', targetId: theirLast.id, reason: 'HARASSMENT' }
                  : { targetType: 'USER', targetId: counterpartId, reason: 'HARASSMENT' },
                {
                  // Said plainly, both ways. A report that appears to vanish
                  // is why people stop reporting.
                  onSuccess: () => setNotice('Reported. Our team will review this conversation.'),
                  onError: () => setNotice('That report did not send. Please try again.'),
                },
              );
            },
          },
          {
            label: `Block ${counterpartName}`,
            icon: 'account-cancel-outline',
            destructive: true,
            onPress: () => { setMenuOpen(false); setConfirmBlock(true); },
          },
        ]}
      />

      <ConfirmDialog
        open={confirmBlock}
        title={`Block ${counterpartName}?`}
        // The two consequences that are actually true, and the one that is
        // not: blocking does not delete what was already said, and promising
        // otherwise here would be the UI lying at the worst moment.
        body="They will not be able to message you, and Swift will not match you with them for a delivery or a ride. Messages already sent stay in this chat. You can undo this in Profile › Blocked people."
        confirmLabel="Block"
        destructive
        loading={blockUser.isPending}
        onConfirm={() => {
          if (!counterpartId) { setConfirmBlock(false); return; }
          blockUser.mutate(
            { blockedUserId: counterpartId },
            {
              onSuccess: () => setNotice(`${counterpartName} is blocked.`),
              onError: () => setNotice('That did not work. Please try again.'),
              onSettled: () => setConfirmBlock(false),
            },
          );
        }}
        onClose={() => setConfirmBlock(false)}
      />

      <ConfirmDialog
        open={notice != null}
        title={notice ?? ''}
        confirmLabel="OK"
        onConfirm={() => setNotice(null)}
        onClose={() => setNotice(null)}
      />
    </Screen>
  );
}
