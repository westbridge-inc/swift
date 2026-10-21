/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { Card, Chip, Header, LabeledInput, PillButton, Screen, T, TonePill } from '../../../kit';
import { useCreateTicket, useMySupportTickets } from '../../../hooks';
import type { SupportCategory } from '../../../services/api';
import { toast } from '../../../kit/toast';

const CATEGORIES: { key: SupportCategory; label: string }[] = [
  { key: 'ORDER_ISSUE', label: 'Order issue' },
  { key: 'PAYMENT', label: 'Payment' },
  { key: 'SAFETY', label: 'Safety' },
  { key: 'MOVER', label: 'Rider / driver' },
  { key: 'VENDOR', label: 'Store' },
  { key: 'ACCOUNT', label: 'Account' },
  { key: 'OTHER', label: 'Something else' },
];

function statusTone(s: string): 'success' | 'brand' | 'neutral' {
  return s === 'RESOLVED' ? 'success' : s === 'IN_PROGRESS' ? 'brand' : 'neutral';
}

type GetHelpPreset = {
  presetOrderId?: string;
  presetCategory?: SupportCategory;
  presetSubject?: string;
  presetMessage?: string;
};

export function GetHelpScreen() {
  const route = useRoute<any>();
  // [E11] Callers with a CONTEXT (a rejected document's appeal door) arrive
  // with the ticket half-written — the document named, the reviewer's words
  // quoted — so the person adds their side instead of reconstructing ours.
  // Plain initial values: everything stays editable.
  const preset: GetHelpPreset = {
    presetOrderId: route.params?.orderId,
    presetCategory: route.params?.category,
    presetSubject: route.params?.subject,
    presetMessage: route.params?.message,
  };
  // [UI-SWEEP U10 S3-1] A tap to a screen already in the stack goes back to
  // it (navigate + pop) and hands the SAME mounted screen the new params. The
  // form is seeded once, so a new door is a new form: keyed on what seeds it,
  // order A's typing can never be filed against order B. The same door handed
  // again keeps what was typed.
  const formKey = JSON.stringify([preset.presetOrderId, preset.presetCategory, preset.presetSubject, preset.presetMessage]);
  return <GetHelpForm key={formKey} {...preset} />;
}

function GetHelpForm({ presetOrderId, presetCategory, presetSubject, presetMessage }: GetHelpPreset) {
  const [category, setCategory] = useState<SupportCategory>(presetCategory ?? (presetOrderId ? 'ORDER_ISSUE' : 'OTHER'));
  const [subject, setSubject] = useState(presetSubject ?? '');
  const [message, setMessage] = useState(presetMessage ?? '');
  const create = useCreateTicket();
  const tickets = useMySupportTickets();

  const valid = subject.trim().length >= 3 && message.trim().length >= 5;

  const submit = () => {
    create.mutate(
      { category, subject: subject.trim(), message: message.trim(), ...(presetOrderId ? { orderId: presetOrderId } : {}) },
      {
        onSuccess: () => {
          toast.success('We’ve got it', 'Our team will follow up — track it here.');
          setSubject('');
          setMessage('');
        },
        onError: (e: any) => {
          toast.error('Couldn’t send that', e?.response?.data?.error?.message ?? 'Please try again.');
        },
      },
    );
  };

  return (
    <Screen>
      <Header title="Get help" />
      <ScrollView contentContainerStyle={{ padding: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        <T variant="body" tone="muted">
          {presetOrderId ? 'Tell us what went wrong with this order — a human answers.' : 'What can we help with? A human answers.'}
        </T>

        <T variant="heading" style={{ marginTop: space.xl, marginBottom: space.sm }}>
          Topic
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {CATEGORIES.map((c) => (
            <Chip key={c.key} label={c.label} selected={c.key === category} onPress={() => setCategory(c.key)} />
          ))}
        </View>

        <Card style={{ marginTop: space.xl, gap: space.md }}>
          <LabeledInput value={subject} onChangeText={setSubject} placeholder="Short summary" />
          <LabeledInput value={message} onChangeText={setMessage} placeholder="Tell us what happened…" multiline />
        </Card>

        {/* [#947's grammar] Disabled says the ask. */}
        <PillButton
          label={
            subject.trim().length < 3
              ? 'Add a short summary'
              : message.trim().length < 5
                ? 'Tell us what happened'
                : 'Submit'
          }
          size="md"
          style={{ marginTop: space.lg }}
          disabled={!valid}
          loading={create.isPending}
          onPress={submit}
        />

        {(tickets.data ?? []).length > 0 ? (
          <>
            <T variant="heading" style={{ marginTop: space['2xl'], marginBottom: space.sm }}>
              Your tickets
            </T>
            {(tickets.data ?? []).map((t: any) => (
              <View key={t.id} style={{ borderRadius: radius.lg, backgroundColor: color.surface.base, padding: space.md, marginBottom: space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <T variant="body" weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
                    {t.subject}
                  </T>
                  <TonePill label={t.status === 'RESOLVED' ? 'Resolved' : t.status === 'IN_PROGRESS' ? 'In progress' : 'Open'} tone={statusTone(t.status)} />
                </View>
                {t.adminNote ? (
                  <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                    Swift: {t.adminNote}
                  </T>
                ) : null}
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
