/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@swift/ui';
import { Card, LabeledInput, PillButton, T } from '../../../kit';
import { useRegisterAdvertiser } from '../../../hooks/advertiser';
import { errorMessage } from '../../../lib/apiError';

// §4.2 — the advertiser application. Creates a PENDING_REVIEW Advertiser in
// the founder's queue; the applicant becomes OWNER and lands in the gated
// preview until approved.

// Must mirror AdvertiserService.INDUSTRIES — the server zod-rejects others.
const INDUSTRIES = [
  'Retail', 'Food & Beverage', 'Entertainment', 'Telecom', 'Financial',
  'Automotive', 'Real Estate', 'Services', 'Other',
] as const;

export function AdvertiserRegisterScreen() {
  const insets = useSafeAreaInsets();
  const register = useRegisterAdvertiser();
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState<string>('Retail');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('+592');
  const [website, setWebsite] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    register.mutate(
      {
        companyName: companyName.trim(),
        industry,
        contactName: contactName.trim(),
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim(),
        ...(website.trim() ? { website: website.trim() } : {}),
      },
      { onError: (e) => setError(errorMessage(e, 'Could not submit your application.')) },
    );
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: color.surface.subtle }}
      contentContainerStyle={{ paddingTop: insets.top + space['2xl'], padding: space['2xl'], paddingBottom: space['3xl'] }}
      keyboardShouldPersistTaps="handled"
    >
      <T variant="title">Advertise on Swift</T>
      <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
        Put your business on the home screen every customer opens. Flat weekly rates, no auctions. Applications are
        reviewed within a day.
      </T>

      <Card style={{ marginTop: space['2xl'], padding: space['2xl'], gap: space.lg }}>
        <LabeledInput label="Company name" value={companyName} onChangeText={setCompanyName} placeholder="Regent Street Roti" />
        <View>
          <T variant="label" weight="semibold" style={{ marginBottom: space.sm }}>
            Industry
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {INDUSTRIES.map((i) => (
              <PillButton key={i} label={i} size="sm" variant={industry === i ? 'primary' : 'soft'} onPress={() => setIndustry(i)} />
            ))}
          </View>
        </View>
        <LabeledInput label="Contact name" value={contactName} onChangeText={setContactName} placeholder="Who runs your ads?" />
        <LabeledInput label="Contact email" value={contactEmail} onChangeText={setContactEmail} placeholder="ads@yourbusiness.gy" autoCapitalize="none" keyboardType="email-address" />
        <LabeledInput label="Contact phone" value={contactPhone} onChangeText={setContactPhone} placeholder="+5926001234" keyboardType="phone-pad" />
        <LabeledInput label="Website (optional)" value={website} onChangeText={setWebsite} placeholder="https://…" autoCapitalize="none" />
        {error ? (
          <T variant="label" style={{ color: color.error }}>
            {error}
          </T>
        ) : null}
        <PillButton
          label="Submit application"
          loading={register.isPending}
          disabled={!companyName.trim() || !contactName.trim() || !contactEmail.trim()}
          onPress={submit}
        />
      </Card>

      <T variant="caption" tone="muted" style={{ marginTop: space.lg }}>
        By applying you agree ads must meet Swift's content rules. You'll be able to draft campaigns immediately;
        payment unlocks once your account is approved.
      </T>
    </ScrollView>
  );
}
