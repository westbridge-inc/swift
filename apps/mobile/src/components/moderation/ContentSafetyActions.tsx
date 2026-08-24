/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, TextInput, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { color, font, fontSize, radius, space } from '@swift/ui';
import { Chip, IconChip, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { toast } from '../ui/toast';
import { moderationApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { clearAdServeCache } from '../../lib/ads';
import {
  buildReportInput,
  REPORT_REASONS,
  type ModerationTargetType,
  type ReportReason,
} from '../../lib/moderation';

function apiMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { data?: { error?: { message?: string }; message?: string } } })?.response;
  return response?.data?.error?.message
    ?? response?.data?.message
    ?? fallback;
}

export function ContentSafetyActions({
  targetType,
  targetId,
  contentLabel = 'content',
  allowBlock = true,
  onBlocked,
  style,
}: {
  targetType: ModerationTargetType;
  targetId: string;
  contentLabel?: string;
  allowBlock?: boolean;
  onBlocked?: () => void;
  style?: ViewStyle;
}) {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const promptLogin = useAuthStore((state) => state.promptLogin);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [reporting, setReporting] = useState(false);
  const [blocking, setBlocking] = useState(false);

  if (!targetId) return null;

  const requireAccount = (next: () => void) => {
    if (!isAuthenticated) {
      promptLogin();
      return;
    }
    next();
  };

  const closeReport = () => {
    if (reporting) return;
    setReportOpen(false);
    setReason(null);
    setDetail('');
  };

  const submitReport = async () => {
    if (!reason || reporting) return;
    setReporting(true);
    try {
      await moderationApi.report(buildReportInput(targetType, targetId, reason, detail));
      // Do not call closeReport here: reporting is deliberately true while the
      // request is in flight, so its user-dismiss guard would keep the modal
      // open after a successful submission.
      setReportOpen(false);
      setReason(null);
      setDetail('');
      toast.success('Report sent', 'Swift’s safety team will review it.');
    } catch (error) {
      toast.error('Couldn’t send report', apiMessage(error, 'Please try again.'));
    } finally {
      setReporting(false);
    }
  };

  const submitBlock = async () => {
    if (blocking) return;
    setBlocking(true);
    try {
      await moderationApi.blockTarget({ targetType, targetId });
      setBlockOpen(false);
      // Purge pre-block payloads (order counterpart phone, chat preview,
      // reviews, listings and ads). The server is authoritative, but a cached
      // response must not keep the newly blocked person's content/contact UI
      // visible until its ordinary stale time expires.
      clearAdServeCache();
      void queryClient.invalidateQueries();
      toast.success('Account blocked', 'Their content is now hidden and they can’t contact you.');
      onBlocked?.();
    } catch (error) {
      toast.error('Couldn’t block account', apiMessage(error, 'Please try again.'));
    } finally {
      setBlocking(false);
    }
  };

  return (
    <>
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.lg }, style]}>
        <Pressable
          onPress={() => requireAccount(() => setReportOpen(true))}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Report ${contentLabel}`}
        >
          {({ pressed }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, opacity: pressed ? 0.55 : 1 }}>
              <Feather name="flag" size={13} color={color.text.muted} />
              <T variant="caption" tone="muted">Report</T>
            </View>
          )}
        </Pressable>
        {allowBlock ? (
          <Pressable
            onPress={() => requireAccount(() => setBlockOpen(true))}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Block the account behind this ${contentLabel}`}
          >
            {({ pressed }) => (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, opacity: pressed ? 0.55 : 1 }}>
                <Feather name="slash" size={13} color={color.text.muted} />
                <T variant="caption" tone="muted">Block</T>
              </View>
            )}
          </Pressable>
        ) : null}
      </View>

      <PopupCard visible={reportOpen} onClose={closeReport}>
        <IconChip icon="flag" size={56} />
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Report {contentLabel}
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          Tell us why this may break Swift’s safety rules.
        </T>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Reason for report"
          style={{ alignSelf: 'stretch', flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xl }}
        >
          {REPORT_REASONS.map((option) => (
            <Chip
              key={option.code}
              label={option.label}
              selected={reason === option.code}
              onPress={() => setReason(option.code)}
              style={{ minHeight: 40, paddingHorizontal: space.md }}
            />
          ))}
        </View>
        <View
          style={{
            alignSelf: 'stretch',
            minHeight: 96,
            marginTop: space.lg,
            padding: space.md,
            borderWidth: 1,
            borderColor: color.border.subtle,
            borderRadius: radius.md,
            backgroundColor: color.surface.subtle,
          }}
        >
          <TextInput
            accessibilityLabel="More details, optional"
            value={detail}
            onChangeText={setDetail}
            placeholder="Add details (optional)"
            placeholderTextColor={color.text.muted}
            multiline
            maxLength={1000}
            style={{ minHeight: 70, fontFamily: font.body, fontSize: fontSize.base, color: color.text.primary, textAlignVertical: 'top' }}
          />
        </View>
        <T variant="caption" tone="faint" style={{ alignSelf: 'flex-end', marginTop: space.xs }}>
          {detail.length}/1000
        </T>
        <PillButton
          label="Send report"
          icon="flag"
          loading={reporting}
          disabled={!reason}
          onPress={() => void submitReport()}
          style={{ alignSelf: 'stretch', marginTop: space.lg }}
        />
        <PillButton label="Cancel" variant="soft" onPress={closeReport} style={{ alignSelf: 'stretch', marginTop: space.md }} />
      </PopupCard>

      <PopupCard visible={blockOpen} onClose={() => !blocking && setBlockOpen(false)}>
        <IconChip icon="slash" size={56} tone="error" />
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Block this account?
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          You won’t see their content and neither of you can contact the other. You can undo this from Profile → Blocked accounts.
        </T>
        <PillButton
          label="Block account"
          icon="slash"
          variant="destructive"
          loading={blocking}
          onPress={() => void submitBlock()}
          style={{ alignSelf: 'stretch', marginTop: space.xl }}
        />
        <PillButton
          label="Cancel"
          variant="soft"
          disabled={blocking}
          onPress={() => setBlockOpen(false)}
          style={{ alignSelf: 'stretch', marginTop: space.md }}
        />
      </PopupCard>
    </>
  );
}
