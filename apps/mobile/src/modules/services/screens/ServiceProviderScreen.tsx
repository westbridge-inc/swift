/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { color, space } from '@swift/ui';
import {
  Card,
  EmptyState,
  ErrorState,
  Header,
  IconChip,
  LabeledInput,
  LoadingBlock,
  PillButton,
  Screen,
  T,
  TonePill,
} from '../../../kit';
import { DocumentChecklist } from '../../../components/onboarding/DocumentChecklist';
import {
  useSaveServiceProvider,
  useServiceProviderProfile,
  useVerificationStatus,
} from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import {
  enterServiceProvider,
  serviceProviderScreenMode,
} from '../serviceProviderEntry';

interface ProviderProfile {
  id: string;
  trade: string;
  bio?: string | null;
  isVerified: boolean;
  certified?: boolean;
}

function ProviderProfileForm({
  existing,
  onSaved,
}: {
  existing?: ProviderProfile;
  onSaved: () => void;
}) {
  const save = useSaveServiceProvider();
  const [trade, setTrade] = useState(existing?.trade ?? '');
  const [bio, setBio] = useState(existing?.bio ?? '');
  const valid = trade.trim().length >= 2;
  const message = (save.error as any)?.response?.data?.error?.message;

  const submit = () => {
    if (!valid) return;
    save.mutate(
      { trade: trade.trim(), bio: bio.trim() },
      { onSuccess: onSaved },
    );
  };

  return (
    <Card style={{ gap: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <IconChip icon="tool" />
        <View style={{ flex: 1 }}>
          <T variant="heading">{existing ? 'Your provider profile' : 'What service do you offer?'}</T>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
            One profile per account. You can update these details later.
          </T>
        </View>
      </View>
      <LabeledInput
        label="Trade or service"
        value={trade}
        onChangeText={setTrade}
        placeholder="Electrician, cleaner, carpenter…"
        autoCapitalize="words"
        maxLength={60}
      />
      <LabeledInput
        label="About your work (optional)"
        value={bio}
        onChangeText={setBio}
        placeholder="Experience, areas served, and the work you do"
        multiline
        maxLength={2000}
        style={{ minHeight: 88, textAlignVertical: 'top' }}
      />
      {save.isError ? (
        <T variant="label" tone="error">
          {message ?? 'Couldn’t save your provider profile. Try again.'}
        </T>
      ) : null}
      {/* [#947's grammar] Disabled says the ask. */}
      <PillButton
        label={!valid ? 'Name your trade first' : existing ? 'Save changes' : 'Create provider profile'}
        disabled={!valid}
        loading={save.isPending}
        onPress={submit}
      />
    </Card>
  );
}

function ProviderDashboard({
  provider,
  navigation,
  refetchProfile,
}: {
  provider: ProviderProfile;
  navigation: any;
  refetchProfile: () => unknown;
}) {
  const [editing, setEditing] = useState(false);
  const statusQuery = useVerificationStatus<any>('SERVICE_PROVIDER', undefined, { poll: true });
  const status = statusQuery.data;

  // The approval path persists public listability before returning. Refresh the
  // profile projection as soon as the shared checklist reports completion.
  useEffect(() => {
    if (status?.roleVerified && !provider.isVerified) void refetchProfile();
  }, [provider.isVerified, refetchProfile, status?.roleVerified]);

  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'], gap: space.xl }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <IconChip icon={provider.isVerified ? 'check-circle' : 'shield'} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm }}>
            <T variant="heading">{provider.trade}</T>
            <TonePill
              label={provider.isVerified ? 'Live' : status?.roleVerified ? 'Activating' : 'Not live yet'}
              tone={provider.isVerified ? 'success' : 'neutral'}
            />
            {provider.certified ? <TonePill label="Certified" tone="success" /> : null}
          </View>
          <T variant="label" tone="muted" style={{ marginTop: 4 }}>
            {provider.isVerified
              ? 'Customers can find you and send job requests.'
              : 'Complete the required checks below before customers can find you.'}
          </T>
          {provider.bio ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              {provider.bio}
            </T>
          ) : null}
        </View>
      </Card>

      <View style={{ flexDirection: 'row', gap: space.md }}>
        <PillButton
          label="Provider jobs"
          onPress={() => navigation?.navigate?.('ServiceJobs')}
          style={{ flex: 1 }}
        />
        <PillButton
          label={editing ? 'Close editor' : 'Edit profile'}
          variant="soft"
          onPress={() => setEditing((value) => !value)}
          style={{ flex: 1 }}
        />
      </View>

      {editing ? (
        <ProviderProfileForm
          existing={provider}
          onSaved={() => {
            setEditing(false);
            void refetchProfile();
          }}
        />
      ) : null}

      <View style={{ padding: space.xs }}>
        <DocumentChecklist
          role="SERVICE_PROVIDER"
          status={status}
          isLoading={statusQuery.isLoading}
          isError={statusQuery.isError}
          onRetry={statusQuery.refetch}
        />
      </View>

      <Card style={{ backgroundColor: color.brand[50] }}>
        <T variant="label" weight="semibold" tone="deep">
          One account, one platform
        </T>
        <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
          Keep using Swift as a customer. Provider requests and your work dashboard stay here under Services.
        </T>
      </Card>
    </ScrollView>
  );
}

function AuthenticatedServiceProviderScreen({ navigation }: any) {
  const profile = useServiceProviderProfile<ProviderProfile>();

  return (
    <Screen>
      <Header title="Provider dashboard" />
      {profile.isLoading ? (
        <LoadingBlock />
      ) : profile.isError ? (
        <ErrorState onRetry={profile.refetch} message="We couldn’t load your provider profile." />
      ) : profile.data ? (
        <ProviderDashboard
          provider={profile.data}
          navigation={navigation}
          refetchProfile={profile.refetch}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'], gap: space.xl }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View>
            <T variant="title">Earn with your skills</T>
            <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
              Create your profile, complete the country-required checks, then receive job requests from Swift customers.
            </T>
          </View>
          <ProviderProfileForm onSaved={() => void profile.refetch()} />
        </ScrollView>
      )}
    </Screen>
  );
}

export function ServiceProviderScreen({ navigation }: any) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const promptLogin = useAuthStore((state) => state.promptLogin);

  if (serviceProviderScreenMode(isAuthenticated) === 'sign-in-required') {
    return (
      <Screen>
        <Header title="Provider dashboard" />
        <View style={{ flex: 1, paddingHorizontal: space['2xl'], justifyContent: 'center' }}>
          <EmptyState
            icon="briefcase"
            title="Sign in to offer services"
            body="Your provider profile, verification, and jobs stay securely linked to your Swift account."
            actionLabel="Sign in or sign up"
            onAction={() => enterServiceProvider({
              isAuthenticated,
              promptLogin,
              navigate: (screen) => navigation?.navigate?.(screen),
            })}
          />
        </View>
      </Screen>
    );
  }

  return <AuthenticatedServiceProviderScreen navigation={navigation} />;
}
