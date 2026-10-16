/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { PillButton, T } from '../kit';
import { toast } from '../kit/toast';
import { useWithdrawStaffInvites } from '../hooks/vendorops';

// [Row 55] Invites nobody has answered are never listed to the owner (that
// would show which typed numbers are Swift accounts), so a mistyped number is
// taken back together with every other unanswered invite. Members stay.

function errorMessage(error: unknown): string {
  const e = error as { response?: { data?: { error?: { message?: string } } } };
  return e?.response?.data?.error?.message ?? 'That didn’t go through. Try again.';
}

export function WithdrawStaffInvites() {
  const withdraw = useWithdrawStaffInvites();
  return (
    <View style={{ marginTop: space.lg, gap: space.sm }}>
      <T variant="caption" tone="muted">
        Typed a wrong number? Withdraw every invite nobody has answered yet. People already on your team stay.
      </T>
      <PillButton
        label="Withdraw unanswered invites"
        variant="outline"
        size="sm"
        loading={withdraw.isPending}
        disabled={withdraw.isPending}
        onPress={() =>
          withdraw.mutate(undefined, {
            onSuccess: (data?: { message?: string }) => toast.success(data?.message ?? 'Unanswered invites withdrawn.'),
            onError: (error: unknown) => toast.error(errorMessage(error)),
          })
        }
      />
    </View>
  );
}
