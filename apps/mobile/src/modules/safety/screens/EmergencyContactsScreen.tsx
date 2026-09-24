/** @jsxImportSource react */
import React, { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import {
  Card,
  CodeInput,
  ConfirmDialog,
  DecorativeIcon,
  EmptyState,
  ErrorState,
  Header,
  IconChip,
  LabeledInput,
  LoadingBlock,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  T,
} from '../../../kit';
import {
  useAddEmergencyContact,
  useEmergencyContacts,
  useRemoveEmergencyContact,
  useResendEmergencyContactCode,
  useVerifyEmergencyContact,
  type EmergencyContact,
} from '../../../hooks/safety';
import { DialCodeChip } from '../../../kit/dial-code-chip';
import { DEFAULT_COUNTRY } from '../../../lib/markets';
import { clampPhone, phoneExample } from '../../../lib/phone';
import { EMERGENCY_CONTACT_CTA, emergencyContactForm } from '../../../lib/emergencyContactForm';

/**
 * The people an SOS actually reaches.
 *
 * [S15] `sos.service.ts` fans an ACTIVE alert out to VERIFIED emergency
 * contacts by SMS, in priority order, best-effort per contact, with receipts.
 * That branch has been live since the safety engine was built — and no screen
 * in the app could ever add a contact, so the query behind it returned an
 * empty list for every user on the platform. The emergency button reached ops
 * and reached nobody else. This screen is the missing half.
 *
 * WHY THE CODE HANDSHAKE MATTERS, and why it is shown so plainly here: the
 * server refuses to fan out to an UNVERIFIED row. A mistyped digit would
 * otherwise mean an emergency SMS waking a stranger while the person who was
 * supposed to be called hears nothing — and the owner would never know,
 * because a typo looks exactly like a saved contact. So an unverified contact
 * says so on its face, in the words that matter: it will not be alerted.
 */
export function EmergencyContactsScreen() {
  const contacts = useEmergencyContacts();
  const add = useAddEmergencyContact();
  const verify = useVerifyEmergencyContact();
  const resend = useResendEmergencyContactCode();
  const remove = useRemoveEmergencyContact();

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  // Local digits only, typed the way sign-in takes a number: the market's
  // calling code is fixed in front (lib/emergencyContactForm composes E.164).
  const [digits, setDigits] = useState('');
  const [relationship, setRelationship] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);

  const [verifying, setVerifying] = useState<EmergencyContact | null>(null);
  const [code, setCode] = useState('');
  const [removing, setRemoving] = useState<EmergencyContact | null>(null);

  const rows = contacts.data ?? [];

  const addError = add.isError
    ? ((add.error as any)?.response?.data?.error?.message ?? 'Could not save that contact.')
    : undefined;
  const verifyError = verify.isError
    ? ((verify.error as any)?.response?.data?.error?.message ?? 'That code did not match. Ask them to read it again.')
    : undefined;

  const form = emergencyContactForm({
    name,
    digits,
    dialCode: DEFAULT_COUNTRY.dialCode,
    countryCode: DEFAULT_COUNTRY.code,
    nameTouched,
    phoneTouched,
  });

  const resetAdd = () => {
    setAdding(false);
    setName('');
    setDigits('');
    setRelationship('');
    setNameTouched(false);
    setPhoneTouched(false);
    add.reset();
  };

  const submitAdd = () => {
    if (!form.canSubmit) return; // guarded by the button, restated so no call site can bypass it
    add.mutate(
      {
        name: name.trim(),
        phoneE164: form.phoneE164,
        ...(relationship.trim() ? { relationship: relationship.trim() } : {}),
      },
      { onSuccess: resetAdd },
    );
  };

  const submitVerify = () => {
    if (!verifying || code.length < 4) return;
    verify.mutate(
      { id: verifying.id, code },
      { onSuccess: () => { setVerifying(null); setCode(''); } },
    );
  };

  return (
    <Screen>
      <Header title="Emergency Contacts" />

      {contacts.isLoading ? (
        <LoadingBlock />
      ) : contacts.isError ? (
        <ErrorState onRetry={() => contacts.refetch()} />
      ) : (
        <>
          <FlatList
            data={rows}
            keyExtractor={(c) => c.id}
            contentContainerStyle={{ padding: space['2xl'], gap: space.md }}
            ListHeaderComponent={
              <View style={{ gap: space.sm, paddingBottom: space.md }}>
                <T variant="body" tone="muted">
                  If you hold the emergency button during a trip or a delivery, these people are
                  texted where you are and asked to check on you.
                </T>
                <T variant="caption" tone="muted">
                  Each number is confirmed first: they receive a 6-digit code and read it back to
                  you. Until that is done, they will not be contacted.
                </T>
              </View>
            }
            ListEmptyComponent={
              <EmptyState
                icon="users"
                title="No one is listed yet"
                body="If you trigger an emergency alert today, Swift can reach our team — but nobody who knows you."
                actionLabel="Add someone"
                onAction={() => setAdding(true)}
              />
            }
            renderItem={({ item: c }) => {
              const verified = c.verifiedAt != null;
              return (
                <Card style={{ gap: space.md, padding: space.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                    <IconChip icon="user" />
                    <View style={{ flex: 1, gap: 2 }}>
                      <T variant="body" weight="semibold">{c.name}</T>
                      <T variant="caption" tone="muted">
                        {[c.phoneE164, c.relationship].filter(Boolean).join(' · ')}
                      </T>
                    </View>
                    <Pressable
                      onPress={() => setRemoving(c)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${c.name}`}
                      hitSlop={space.sm}
                      style={{ padding: space.sm }}
                    >
                      <Feather name="trash-2" size={16} color={color.error} />
                    </Pressable>
                  </View>

                  {/* The honest state of this row. An unverified contact is not
                      a pending nicety — it is a person who will NOT be called. */}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.sm,
                      padding: space.sm,
                      borderRadius: radius.sm,
                      backgroundColor: verified ? color.soft.success : color.soft.warning,
                    }}
                  >
                    <Feather
                      name={verified ? 'check-circle' : 'alert-triangle'}
                      size={14}
                      color={verified ? color.success : color.warning}
                    />
                    <T variant="caption" weight="medium" style={{ flex: 1 }}>
                      {verified ? 'Confirmed — will be alerted' : 'Not confirmed — will NOT be alerted'}
                    </T>
                  </View>

                  {verified ? null : (
                    <View style={{ flexDirection: 'row', gap: space.sm }}>
                      <View style={{ flex: 1 }}>
                        <PillButton
                          label="Enter their code"
                          onPress={() => { setVerifying(c); setCode(''); }}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <PillButton
                          label="Text it again"
                          variant="outline"
                          loading={resend.isPending && (resend.variables as string) === c.id}
                          onPress={() => resend.mutate(c.id)}
                        />
                      </View>
                    </View>
                  )}
                </Card>
              );
            }}
          />

          {rows.length > 0 ? (
            <View style={{ paddingHorizontal: space['2xl'], paddingBottom: space['2xl'] }}>
              <PillButton label="Add Contact" icon="plus" onPress={() => setAdding(true)} />
            </View>
          ) : null}
        </>
      )}

      <PopupCard visible={adding} onClose={resetAdd}>
        {/* THE FORM IS A STRETCHED COLUMN. PopupCard centres its content —
            right for the pictogram-and-two-buttons dialogs it was built for —
            so a child with no width of its own shrinks to its content. These
            three inputs used to sit directly in the card and came out as
            ~140px boxes, centred, placeholders cut to "Sister, pa…": the
            broken form on the owner's phone. Every other popup form in the app
            wraps its fields in `alignSelf: 'stretch'`; this one now does too.
            The card's own KeyboardAvoidingView + ScrollView keep the fields
            and the button above the keyboard. */}
        <View style={{ alignSelf: 'stretch', gap: space.lg }}>
          <PopupTitle>Add an emergency contact</PopupTitle>
          <T variant="caption" tone="muted">
            We text them a 6-digit code now. Ask them to read it back to you, so we know the number
            is right before an emergency depends on it.
          </T>
          <LabeledInput
            label="Their name"
            icon="user"
            placeholder="e.g. Anita"
            value={name}
            onChangeText={setName}
            onBlur={() => setNameTouched(true)}
            autoCapitalize="words"
            error={form.nameHint}
          />
          {/* Local digits on the numeric keypad behind a fixed +592, exactly as
              sign-in takes a number; the value sent is E.164. */}
          <LabeledInput
            label="Their phone"
            icon="phone"
            accessibilityLabel="Their phone number"
            accessibilityHint="Enter their number without the country calling code"
            placeholder={phoneExample(DEFAULT_COUNTRY.code)}
            keyboardType="phone-pad"
            maxLength={15}
            value={digits}
            onChangeText={(typed) => setDigits(clampPhone(DEFAULT_COUNTRY.dialCode, typed))}
            onBlur={() => setPhoneTouched(true)}
            error={form.phoneHint}
            right={<DialCodeChip countryCode={DEFAULT_COUNTRY.code} dialCode={DEFAULT_COUNTRY.dialCode} countryName={DEFAULT_COUNTRY.name} />}
          />
          <LabeledInput
            label="Relationship (optional)"
            icon="heart"
            placeholder="Sister, partner, neighbour…"
            value={relationship}
            onChangeText={setRelationship}
          />
          {/* The server's own words for a refused save (too many contacts, the
              number's SMS budget, a send failure) — under the form, not under
              a field they are not about. */}
          {addError ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <DecorativeIcon>
                <Feather name="alert-circle" size={13} color={color.error} />
              </DecorativeIcon>
              <T variant="caption" tone="error" style={{ flex: 1 }}>{addError}</T>
            </View>
          ) : null}
          {/* The button says what it does; what is missing is said under the
              field it belongs to (lib/emergencyContactForm), never here. */}
          <PillButton
            label={EMERGENCY_CONTACT_CTA}
            loading={add.isPending}
            disabled={!form.canSubmit}
            onPress={submitAdd}
          />
        </View>
      </PopupCard>

      <PopupCard visible={verifying != null} onClose={() => { setVerifying(null); setCode(''); }}>
        <View style={{ alignSelf: 'stretch', gap: space.lg }}>
          <PopupTitle>{`Confirm ${verifying?.name ?? 'this contact'}`}</PopupTitle>
          <T variant="caption" tone="muted">
            {`Ask ${verifying?.name ?? 'them'} for the 6-digit code we texted to ${verifying?.phoneE164 ?? 'their phone'}.`}
          </T>
          <CodeInput value={code} onChange={setCode} error={verify.isError} />
          {verifyError ? (
            <T variant="caption" style={{ color: color.error }}>{verifyError}</T>
          ) : null}
          <PillButton
            label="Confirm"
            loading={verify.isPending}
            disabled={code.length < 4}
            onPress={submitVerify}
          />
        </View>
      </PopupCard>

      <ConfirmDialog
        open={removing != null}
        title={`Remove ${removing?.name ?? 'this contact'}?`}
        body="They will no longer be texted if you trigger an emergency alert."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          const target = removing;
          if (!target) return;
          remove.mutate(target.id, { onSettled: () => setRemoving(null) });
        }}
        onClose={() => setRemoving(null)}
      />
    </Screen>
  );
}
