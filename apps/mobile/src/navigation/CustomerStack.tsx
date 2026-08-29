/** @jsxImportSource react */
import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StyleSheet, Text } from 'react-native';
import { color, font, fontSize } from '@swift/ui';
import { TabGlyph, type TabGlyphName } from '../kit';

// Rebuilt customer screens (Super Food layouts, Indian Red brand)
import { HomeScreen } from '../modules/shop/screens/HomeScreen';
import { RecommendedScreen } from '../modules/shop/screens/RecommendedScreen';
import { NearbyScreen } from '../modules/shop/screens/NearbyScreen';
import { SearchScreen } from '../modules/shop/screens/SearchScreen';
import { CategoryFeedScreen } from '../modules/shop/screens/CategoryFeedScreen';
import { CategoryGridScreen } from '../modules/shop/screens/CategoryGridScreen';
import { RestaurantScreen } from '../modules/shop/screens/RestaurantScreen';
import { MenuItemScreen } from '../modules/shop/screens/MenuItemScreen';
import { FavoritesScreen } from '../modules/shop/screens/FavoritesScreen';
import { ScanScreen } from '../modules/shop/screens/ScanScreen';
import { VendorReviewsScreen } from '../modules/shop/screens/VendorReviewsScreen';
import { CartScreen } from '../modules/cart/screens/CartScreen';
import { OrdersHistoryScreen } from '../modules/orders/screens/OrdersHistoryScreen';
import { MarketScreen } from '../modules/shop/screens/MarketScreen';
import { DeliveryScreen } from '../modules/orders/screens/DeliveryScreen';
import { FeedbackScreen } from '../modules/orders/screens/FeedbackScreen';
import { ChatListScreen } from '../modules/chat/screens/ChatListScreen';
import { ConversationScreen } from '../modules/chat/screens/ConversationScreen';
import { ProfileScreen } from '../modules/profile/screens/ProfileScreen';
import { PersonalDataScreen } from '../modules/profile/screens/PersonalDataScreen';
import { NotificationsScreen } from '../modules/profile/screens/NotificationsScreen';
import { InviteFriendsScreen } from '../modules/profile/screens/InviteFriendsScreen';
import { FaqScreen } from '../modules/profile/screens/FaqScreen';
import { ContactUsScreen } from '../modules/profile/screens/ContactUsScreen';
import { GetHelpScreen } from '../modules/profile/screens/GetHelpScreen';
import { AddressesScreen } from '../modules/profile/screens/AddressesScreen';
import { AddAddressScreen } from '../modules/profile/screens/AddAddressScreen';
import { EmergencyContactsScreen } from '../modules/safety/screens/EmergencyContactsScreen';
import { BlockedUsersScreen } from '../modules/safety/screens/BlockedUsersScreen';
import { LocationPickerScreen } from '../modules/profile/screens/LocationPickerScreen';

// Surviving verticals + infra (outside this rebuild's scope, still reachable)
import { TaxiScreen } from '../modules/movement/screens/TaxiScreen';
import { CourierScreen } from '../modules/movement/screens/CourierScreen';
import { DestinationSearchScreen } from '../modules/movement/screens/DestinationSearchScreen';
import { PinConfirmScreen } from '../modules/movement/screens/PinConfirmScreen';
import { ServicesScreen } from '../modules/services/screens/ServicesScreen';
import { ServiceJobsScreen } from '../modules/services/screens/ServiceJobsScreen';
import { ServiceProviderScreen } from '../modules/services/screens/ServiceProviderScreen';
import { IdentityVerificationScreen } from '../modules/account/screens/IdentityVerificationScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Tab bar: Home · Market · Cart · Profile (filled icon when active).
//
// [MKT-2, founder-approved 2026-08-24] Market REPLACES Activity. Goods — clothes,
// tools, household things — get the second slot, and "Shops" leaves Home because
// it stops being a tile and becomes this tab.
//
// Demoting Activity was gated on two things, both satisfied before this shipped:
//   1. An in-flight order stays visible without it. HomeScreen already renders
//      `feed.activeOrder` with its live status, so a customer mid-order sees it
//      on the screen they land on.
//   2. Nothing lands on a dead screen. Orders & rides live in Profile → "My
//      orders" (ProfileScreen.tsx, already shipped) and `OrdersHistory` remains a
//      registered stack route, so every existing path still resolves. There were
//      exactly two `navigate('Tabs', { screen: 'Activity' })` call sites — both on
//      Home, both now pointing at OrdersHistory — and NO push notification
//      targeted the Activity tab (verified against notification-router).
const TAB_ICON: Record<string, TabGlyphName> = {
  Home: 'home',
  Market: 'market',
  Cart: 'cart',
  Profile: 'profile',
};

function HomeTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: color.brand[500],
        tabBarInactiveTintColor: color.text.muted,
        // THE DOCK [100x pass §5]: "Blurred white dock, hairline edge, 25px
        // glyphs, tighter labels; active = filled glyph + semibold label,
        // nothing else."
        //
        // It used to float on a soft upward shadow with no top edge at all. A
        // shadow says "this panel hovers"; a hairline says "the content ends
        // here". The pass wants the second, because the dock is a boundary, not
        // a floating object — and on the paper ground the shadow read as a
        // smudge rather than a lift.
        tabBarStyle: {
          backgroundColor: color.surface.base,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: color.border.subtle,
          elevation: 0,
        },
        // "active = filled glyph + semibold label, nothing else" — the weight
        // change IS the emphasis. No pill, no dot, no background behind the
        // active tab, which is what "nothing else" is guarding against.
        tabBarLabel: ({ focused, color: c, children }) => (
          <Text
            numberOfLines={1}
            style={{
              fontSize: fontSize.micro,
              fontFamily: focused ? font.bodySemiBold : font.bodyMedium,
              color: c,
              marginBottom: 2,
            }}
          >
            {children}
          </Text>
        ),
        tabBarIcon: ({ focused, color: c }) => (
          <TabGlyph name={TAB_ICON[route.name] ?? 'home'} focused={focused} color={c} size={25} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Market" component={MarketScreen} />
      <Tab.Screen name="Cart" component={CartScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

export function CustomerStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs" component={HomeTabs} />
      {/* Shop */}
      <Stack.Screen name="Recommended" component={RecommendedScreen} />
      <Stack.Screen name="Nearby" component={NearbyScreen} />
      <Stack.Screen name="Search" component={SearchScreen} />
      <Stack.Screen name="CategoryFeed" component={CategoryFeedScreen} />
      <Stack.Screen name="CategoryGrid" component={CategoryGridScreen} />
      <Stack.Screen name="Restaurant" component={RestaurantScreen} />
      <Stack.Screen name="MenuItem" component={MenuItemScreen} />
      <Stack.Screen name="Favorites" component={FavoritesScreen} />
      <Stack.Screen name="Scan" component={ScanScreen} />
      <Stack.Screen name="VendorReviews" component={VendorReviewsScreen} />
      {/* Orders */}
      <Stack.Screen name="OrdersHistory" component={OrdersHistoryScreen} />
      <Stack.Screen name="Delivery" component={DeliveryScreen} />
      <Stack.Screen name="Feedback" component={FeedbackScreen} />
      {/* Chat */}
      <Stack.Screen name="ChatList" component={ChatListScreen} />
      <Stack.Screen name="Conversation" component={ConversationScreen} />
      {/* Profile */}
      <Stack.Screen name="PersonalData" component={PersonalDataScreen} />
      <Stack.Screen name="Notifications" component={NotificationsScreen} />
      <Stack.Screen name="InviteFriends" component={InviteFriendsScreen} />
      <Stack.Screen name="Faq" component={FaqScreen} />
      <Stack.Screen name="ContactUs" component={ContactUsScreen} />
      <Stack.Screen name="GetHelp" component={GetHelpScreen} />
      <Stack.Screen name="Addresses" component={AddressesScreen} />
      <Stack.Screen name="AddAddress" component={AddAddressScreen} />
      <Stack.Screen name="EmergencyContacts" component={EmergencyContactsScreen} />
      <Stack.Screen name="BlockedUsers" component={BlockedUsersScreen} />
      <Stack.Screen name="LocationPicker" component={LocationPickerScreen} />
      {/* Surviving verticals + infra */}
      <Stack.Screen name="Taxi" component={TaxiScreen} />
      <Stack.Screen name="Courier" component={CourierScreen} />
      <Stack.Screen name="DestinationSearch" component={DestinationSearchScreen} />
      <Stack.Screen name="PinConfirm" component={PinConfirmScreen} />
      <Stack.Screen name="Services" component={ServicesScreen} />
      <Stack.Screen name="ServiceJobs" component={ServiceJobsScreen} />
      <Stack.Screen name="ServiceProvider" component={ServiceProviderScreen} />
      <Stack.Screen name="IdentityVerification" component={IdentityVerificationScreen} />
    </Stack.Navigator>
  );
}
