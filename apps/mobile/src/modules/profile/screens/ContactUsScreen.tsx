/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { space } from '@swift/ui';
import { Header, Screen, SettingsRow, T } from '../../../kit';
import { openExternal } from '../../../lib/openExternal';
import { SUPPORT_CONTACT } from '../../../lib/supportContact';

// Published launch support channels, read from the one shared config.

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
            icon="message-square"
            label="WhatsApp support"
            sub={SUPPORT_CONTACT.phoneDisplay}
            onPress={() => void openExternal(SUPPORT_CONTACT.whatsappUrl, `Couldn't open WhatsApp — message ${SUPPORT_CONTACT.phoneDisplay} on WhatsApp.`)}
          />
          <SettingsRow
            icon="phone"
            label="Call support"
            sub={SUPPORT_CONTACT.phoneDisplay}
            onPress={() => void openExternal(SUPPORT_CONTACT.callUrl, `Couldn't open your phone app — call ${SUPPORT_CONTACT.phoneDisplay}.`)}
          />
          <SettingsRow
            icon="mail"
            label="Email support"
            sub={SUPPORT_CONTACT.email}
            onPress={() => void openExternal(`mailto:${SUPPORT_CONTACT.email}`, `Couldn't open your mail app — write to ${SUPPORT_CONTACT.email}.`)}
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
