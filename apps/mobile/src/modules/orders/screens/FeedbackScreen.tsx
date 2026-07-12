/** @jsxImportSource react */
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { useOrder, useRateOrder } from '../../../hooks/customer';
import { DARK_BLURHASH, vendorImage } from '../../../lib/images';
import { ErrorState, Header, IconChip, LoadingBlock, PillButton, PopupCard, Screen, Stars, T } from '../../../kit';

const GUTTER = space['2xl'];

function TextArea({ value, onChangeText, placeholder }: { value: string; onChangeText: (v: string) => void; placeholder: string }) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={color.text.muted}
      multiline
      textAlignVertical="top"
      style={{
        minHeight: 120,
        borderWidth: 1,
        borderColor: color.border.subtle,
        borderRadius: radius.lg,
        backgroundColor: color.surface.base,
        padding: space.lg,
        fontFamily: 'Inter',
        fontSize: 16,
        color: color.text.primary,
      }}
    />
  );
}

/** One kit-45 rating block: avatar · name · role · question · stars · textarea. */
function RateBlock({
  image,
  fallbackIcon,
  name,
  role,
  question,
  score,
  onScore,
  comment,
  onComment,
}: {
  image?: string | null;
  fallbackIcon: React.ComponentProps<typeof Feather>['name'];
  name: string;
  role: string;
  question: string;
  score: number;
  onScore: (n: number) => void;
  comment: string;
  onComment: (v: string) => void;
}) {
  return (
    <View style={{ alignItems: 'center' }}>
      {image ? (
        <Image
          source={{ uri: image }}
          placeholder={{ blurhash: DARK_BLURHASH }}
          transition={150}
          style={{ width: 140, height: 140, borderRadius: 70 }}
          contentFit="cover"
        />
      ) : (
        <View
          style={{
            width: 140,
            height: 140,
            borderRadius: 70,
            backgroundColor: color.brand[50],
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name={fallbackIcon} size={48} color={color.brand[600]} />
        </View>
      )}
      <T variant="title" center style={{ marginTop: space.lg }}>
        {name}
      </T>
      <T variant="body" tone="muted" center style={{ marginTop: 4 }}>
        {role}
      </T>
      <T variant="body" tone="muted" center style={{ marginTop: space['2xl'] }}>
        {question}
      </T>
      <View style={{ marginTop: space.lg }}>
        <Stars value={score} size={40} gap={10} onRate={onScore} />
      </View>
      <View style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}>
        <T variant="label" weight="medium" style={{ marginBottom: space.sm }}>
          Feedback
        </T>
        <TextArea value={comment} onChangeText={onComment} placeholder="Tell us what stood out (optional)" />
      </View>
    </View>
  );
}

// Kit Feedback (45–48): order/menu rating + driver rating. Swift submits both
// through one POST /orders/:id/rate — presented as the kit's two frames in
// sequence (skips the driver step when no rider was involved).
export function FeedbackScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const orderId: string = route.params?.orderId;

  const order = useOrder<any>(orderId);
  const rate = useRateOrder(orderId);

  const [step, setStep] = useState<0 | 1>(0);
  const [vendorScore, setVendorScore] = useState(0);
  const [vendorComment, setVendorComment] = useState('');
  const [riderScore, setRiderScore] = useState(0);
  const [riderComment, setRiderComment] = useState('');
  const [done, setDone] = useState(false);

  const o = order.data;
  if (order.isLoading) return <LoadingBlock style={{ backgroundColor: color.surface.subtle }} />;
  if (order.isError || !o) {
    return (
      <Screen>
        <Header title="Feedback" />
        <ErrorState onRetry={() => order.refetch()} />
      </Screen>
    );
  }

  const hasRider = !!o.rider;
  const lastStep = !hasRider || step === 1;

  const submit = () => {
    rate.mutate(
      {
        ...(vendorScore ? { vendorScore, ...(vendorComment.trim() ? { vendorComment: vendorComment.trim() } : {}) } : {}),
        ...(hasRider && riderScore
          ? { riderScore, ...(riderComment.trim() ? { riderComment: riderComment.trim() } : {}) }
          : {}),
      },
      { onSuccess: () => setDone(true) },
    );
  };

  const err = rate.isError
    ? ((rate.error as any)?.response?.data?.error?.message ?? 'Could not submit. Try again.')
    : undefined;

  return (
    <Screen>
      <Header title="Feedback" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, paddingTop: space.xl, paddingBottom: space['2xl'] }}
          keyboardShouldPersistTaps="handled"
        >
          {step === 0 ? (
            <RateBlock
              image={vendorImage(o.vendor ?? {})}
              fallbackIcon="shopping-bag"
              name={o.vendor?.name ?? 'The store'}
              role="Your order"
              question="How was your order?"
              score={vendorScore}
              onScore={setVendorScore}
              comment={vendorComment}
              onComment={setVendorComment}
            />
          ) : (
            <RateBlock
              image={o.rider?.avatar}
              fallbackIcon="user"
              name={`${o.rider?.firstName ?? 'Your rider'} ${o.rider?.lastName ?? ''}`.trim()}
              role="Rider"
              question="How was the delivery of your order?"
              score={riderScore}
              onScore={setRiderScore}
              comment={riderComment}
              onComment={setRiderComment}
            />
          )}

          {err ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.lg }}>
              <Feather name="alert-circle" size={14} color={color.error} />
              <T variant="label" tone="error">
                {err}
              </T>
            </View>
          ) : null}

          <View style={{ flex: 1 }} />
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space['2xl'] }}>
            <PillButton
              label="Cancel"
              variant="soft"
              onPress={() => navigation.goBack()}
              style={{ flex: 1 }}
            />
            <PillButton
              label={lastStep ? 'Submit' : 'Next'}
              disabled={step === 0 ? vendorScore === 0 : riderScore === 0}
              loading={rate.isPending}
              onPress={() => {
                if (!lastStep) setStep(1);
                else submit();
              }}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Thanks popup (kit 46/48) */}
      <PopupCard
        visible={done}
        onClose={() => {
          setDone(false);
          navigation.goBack();
        }}
      >
        <IconChip icon="thumbs-up" size={64} />
        <T variant="heading" center style={{ marginTop: space.md }}>
          Thanks for the feedback!
        </T>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          Ratings keep stores and riders sharp.
        </T>
        <PillButton
          label="Done"
          size="md"
          onPress={() => {
            setDone(false);
            navigation.goBack();
          }}
          style={{ alignSelf: 'stretch', marginTop: space.xl }}
        />
      </PopupCard>
    </Screen>
  );
}
