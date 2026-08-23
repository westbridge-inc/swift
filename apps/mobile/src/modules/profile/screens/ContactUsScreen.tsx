/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { space } from '@swift/ui';
import { Header, Screen, SettingsRow, T } from '../../../kit';
import { openExternal } from '../../../lib/openExternal';

// Kit Contact Us (55). Channels below are the launch support set —
// TODO(SWIFT-117): confirm the final support phone/handles before release.
const SUPPORT_EMAIL = 'support@swift.gy';

export function ContactUsScreen() {
  const navigation = useNavigation<any>();

  return (
    <Screen>
      <Header title="Contact Us" />
      <ScrollView contentContainerStyle={{ padding: space['2xl'] }}>
        <T variant="body" tone="muted">
          Something off with an order, a store, or the app? Reach us — a human answers.
        </T>
        <View style={{ marginTop: space.xl }}>
          <SettingsRow
            icon="life-buoy"
            label="Report a problem"
            sub="Open a support ticket — we track it to resolution"
            onPress={() => navigation.navigate('GetHelp')}
          />
          <SettingsRow
            icon="message-circle"
            label="Message about an active order"
            sub="Fastest — chat with your rider directly"
            onPress={() => navigation.navigate('ChatList')}
          />
          <SettingsRow
            icon="mail"
            label="Email support"
            sub={SUPPORT_EMAIL}
            onPress={() => void openExternal(`mailto:${SUPPORT_EMAIL}`, `Couldn't open your mail app — write to ${SUPPORT_EMAIL}.`)}
          />
          <SettingsRow
            icon="help-circle"
            label="Browse the FAQ"
            sub="Payments, delivery areas, verification"
            onPress={() => navigation.navigate('Faq')}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
