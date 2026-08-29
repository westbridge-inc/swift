/** @jsxImportSource react */
import React, { useState } from 'react';
import { FlatList, View } from 'react-native';
import { color, radius, space } from '@swift/ui';
import {
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Header,
  IconChip,
  LoadingBlock,
  PillButton,
  Screen,
  T,
} from '../../../kit';
import { useBlockedUsers, useUnblockUser, type BlockedPerson } from '../../../hooks/customer';

/** "12 August 2026" — a block's date is the one fact a person checks it for. */
function blockedOn(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The people this user has cut off.
 *
 * [STORE-002] App Store Guideline 1.2 and Google Play's UGC policy both require
 * four things of an app carrying user-generated content: a content filter, a
 * way to report, a way to BLOCK, and a published contact. Swift had three. A
 * customer could report a rider for harassment and be matched with them again
 * the same evening, because nothing on the platform recorded a refusal.
 *
 * WHY THIS SCREEN EXISTS SEPARATELY FROM REPORTING: a report is a message to a
 * human who will read it later. A block takes effect now — chat refuses the
 * send in both directions and dispatch stops pairing them. Those are different
 * promises, and a person in the moment needs the second one. It is also why
 * the list must be reversible from here: a block nobody can find and undo is a
 * trap for the person who placed it, not a protection.
 *
 * The screen states what a block DOES, in the two places it actually bites,
 * because "Blocked" on its own tells a frightened person nothing about whether
 * they are safe from being sent that driver again.
 */
export function BlockedUsersScreen() {
  const blocked = useBlockedUsers();
  const unblock = useUnblockUser();
  const [lifting, setLifting] = useState<BlockedPerson | null>(null);

  const rows = blocked.data ?? [];

  return (
    <Screen>
      <Header title="Blocked people" />

      {blocked.isLoading ? (
        <LoadingBlock />
      ) : blocked.isError ? (
        <ErrorState onRetry={() => blocked.refetch()} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(b) => b.id}
          contentContainerStyle={{ padding: space['2xl'], gap: space.md }}
          ListHeaderComponent={
            rows.length === 0 ? null : (
              <View
                style={{
                  gap: space.sm,
                  padding: space.md,
                  marginBottom: space.sm,
                  borderRadius: radius.sm,
                  backgroundColor: color.soft.success,
                }}
              >
                {/* Named consequences. "Blocked" alone does not tell someone
                    whether they can be sent that driver again tomorrow. */}
                <T variant="caption" weight="medium">
                  While someone is blocked, they cannot message you and you will not be matched with
                  them for a delivery or a ride.
                </T>
                <T variant="caption" tone="muted">
                  Messages you already exchanged stay in your chat history.
                </T>
              </View>
            )
          }
          ListEmptyComponent={
            <EmptyState
              icon="user-x"
              title="You have not blocked anyone"
              body="If someone makes you uncomfortable, you can block them from your chat with them. They will not be able to message you, and Swift will not match you with them again."
            />
          }
          renderItem={({ item: b }) => (
            <Card style={{ gap: space.md, padding: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <IconChip icon="user-x" />
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="body" weight="semibold">{b.name}</T>
                  <T variant="caption" tone="muted">
                    {[`Blocked ${blockedOn(b.blockedAt)}`, b.reason].filter(Boolean).join(' · ')}
                  </T>
                </View>
              </View>
              <PillButton
                label="Unblock"
                variant="outline"
                loading={unblock.isPending && (unblock.variables as string) === b.userId}
                onPress={() => setLifting(b)}
              />
            </Card>
          )}
        />
      )}

      <ConfirmDialog
        open={lifting != null}
        title={`Unblock ${lifting?.name ?? 'this person'}?`}
        body="They will be able to message you again, and Swift may match you with them for a delivery or a ride."
        confirmLabel="Unblock"
        loading={unblock.isPending}
        onConfirm={() => {
          const target = lifting;
          if (!target) return;
          unblock.mutate(target.userId, { onSettled: () => setLifting(null) });
        }}
        onClose={() => setLifting(null)}
      />
    </Screen>
  );
}
