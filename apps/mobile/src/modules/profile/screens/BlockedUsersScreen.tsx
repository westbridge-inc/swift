/** @jsxImportSource react */
import React from 'react';
import { Image, RefreshControl, ScrollView, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { color, radius, space } from '@swift/ui';
import { moderationApi } from '../../../services/api';
import { Card, EmptyState, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { toast } from '../../../components/ui/toast';

type BlockedAccount = {
  blockedUserId: string;
  blockedUser: { id: string; firstName?: string | null; lastName?: string | null; avatar?: string | null } | null;
  blockedAt: string;
};

async function loadBlocks(): Promise<BlockedAccount[]> {
  const response = await moderationApi.blocks();
  const data = response.data?.data;
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.blocks) ? data.blocks : [];
}

function displayName(account: BlockedAccount): string {
  const user = account.blockedUser;
  if (!user) return 'Unavailable account';
  return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Swift member';
}

export function BlockedUsersScreen() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['moderation', 'blocks'], queryFn: loadBlocks });
  const unblock = useMutation({
    mutationFn: (userId: string) => moderationApi.setBlocked(userId, false),
    onSuccess: () => {
      // Re-open every server-authored surface (chat, marketplace, jobs and
      // order counterpart cards) from fresh data after the reversible change.
      void queryClient.invalidateQueries();
      toast.success('Account unblocked');
    },
    onError: (error: unknown) => toast.error(
      'Couldn’t unblock account',
      (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? 'Please try again.',
    ),
  });

  return (
    <Screen>
      <Header title="Blocked accounts" />
      {query.isLoading ? (
        <LoadingBlock />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} message="Couldn’t load blocked accounts." />
      ) : (query.data?.length ?? 0) === 0 ? (
        <EmptyState icon="shield" title="No blocked accounts" body="Accounts you block will appear here so you can unblock them later." />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: space['2xl'], gap: space.md }}
          refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} tintColor={color.brand[500]} />}
        >
          {query.data!.map((account) => {
            const name = displayName(account);
            return (
              <Card key={account.blockedUserId} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                {account.blockedUser?.avatar ? (
                  <Image source={{ uri: account.blockedUser.avatar }} style={{ width: 48, height: 48, borderRadius: radius.full, backgroundColor: color.surface.subtle }} />
                ) : (
                  <View style={{ width: 48, height: 48, borderRadius: radius.full, backgroundColor: color.brand[50], alignItems: 'center', justifyContent: 'center' }}>
                    <T variant="heading" tone="brand">{name[0]?.toUpperCase() ?? 'S'}</T>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <T variant="body" weight="semibold">{name}</T>
                  <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    Blocked {new Date(account.blockedAt).toLocaleDateString()}
                  </T>
                </View>
                <PillButton
                  label="Unblock"
                  variant="outline"
                  size="sm"
                  loading={unblock.isPending && unblock.variables === account.blockedUserId}
                  onPress={() => unblock.mutate(account.blockedUserId)}
                />
              </Card>
            );
          })}
        </ScrollView>
      )}
    </Screen>
  );
}
