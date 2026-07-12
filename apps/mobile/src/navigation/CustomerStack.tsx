/** @jsxImportSource react */
import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { color } from '@swift/ui';

// Rebuilt customer screens (Super Food layouts, Indian Red brand)
import { HomeScreen } from '../modules/shop/screens/HomeScreen';
import { RecommendedScreen } from '../modules/shop/screens/RecommendedScreen';
import { NearbyScreen } from '../modules/shop/screens/NearbyScreen';
import { SearchScreen } from '../modules/shop/screens/SearchScreen';
import { RestaurantScreen } from '../modules/shop/screens/RestaurantScreen';
import { MenuItemScreen } from '../modules/shop/screens/MenuItemScreen';
import { FavoritesScreen } from '../modules/shop/screens/FavoritesScreen';
import { VendorReviewsScreen } from '../modules/shop/screens/VendorReviewsScreen';
import { CartScreen } from '../modules/cart/screens/CartScreen';
import { OrdersHistoryScreen } from '../modules/orders/screens/OrdersHistoryScreen';
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
import { AddressesScreen } from '../modules/profile/screens/AddressesScreen';
import { AddAddressScreen } from '../modules/profile/screens/AddAddressScreen';
import { LocationPickerScreen } from '../modules/profile/screens/LocationPickerScreen';

// Surviving verticals + infra (outside this rebuild's scope, still reachable)
import { TaxiScreen } from '../modules/movement/screens/TaxiScreen';
import { CourierScreen } from '../modules/movement/screens/CourierScreen';
import { DestinationSearchScreen } from '../modules/movement/screens/DestinationSearchScreen';
import { PinConfirmScreen } from '../modules/movement/screens/PinConfirmScreen';
import { ServicesScreen } from '../modules/services/screens/ServicesScreen';
import { ServiceJobsScreen } from '../modules/services/screens/ServiceJobsScreen';
import { IdentityVerificationScreen } from '../modules/account/screens/IdentityVerificationScreen';
// Legacy order-chat screen — movement/mover flows navigate('Chat') into it.
import { ChatScreen } from '../screens/shared/ChatScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Tab bar: Home · Activity · Cart · Profile (filled icon when active).
// Activity is a first-class super-app surface (orders/rides history + live
// status); order chats stay reachable from each order and the chat list.
const TAB_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  Home: 'home',
  Activity: 'receipt',
  Cart: 'bag-handle',
  Profile: 'person',
};

function HomeTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: color.brand[500],
        tabBarInactiveTintColor: color.text.muted,
        // White, hairline-free, floating on an upward shadow — per the kit.
        tabBarStyle: {
          backgroundColor: color.surface.base,
          borderTopWidth: 0,
          shadowColor: '#211A1A',
          shadowOpacity: 0.08,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: -4 },
          elevation: 10,
        },
        tabBarLabelStyle: { fontSize: 12, fontFamily: 'InterMedium' },
        tabBarIcon: ({ focused, color: c, size }) => {
          const base = TAB_ICON[route.name] ?? 'ellipse';
          return <Ionicons name={focused ? base : (`${base}-outline` as typeof base)} size={size} color={c} />;
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Activity" component={OrdersHistoryScreen} />
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
      <Stack.Screen name="Restaurant" component={RestaurantScreen} />
      <Stack.Screen name="MenuItem" component={MenuItemScreen} />
      <Stack.Screen name="Favorites" component={FavoritesScreen} />
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
      <Stack.Screen name="Addresses" component={AddressesScreen} />
      <Stack.Screen name="AddAddress" component={AddAddressScreen} />
      <Stack.Screen name="LocationPicker" component={LocationPickerScreen} />
      {/* Surviving verticals + infra */}
      <Stack.Screen name="Taxi" component={TaxiScreen} />
      <Stack.Screen name="Courier" component={CourierScreen} />
      <Stack.Screen name="DestinationSearch" component={DestinationSearchScreen} />
      <Stack.Screen name="PinConfirm" component={PinConfirmScreen} />
      <Stack.Screen name="Services" component={ServicesScreen} />
      <Stack.Screen name="ServiceJobs" component={ServiceJobsScreen} />
      <Stack.Screen name="IdentityVerification" component={IdentityVerificationScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
    </Stack.Navigator>
  );
}
