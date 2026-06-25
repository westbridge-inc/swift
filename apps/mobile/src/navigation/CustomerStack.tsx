import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from '../modules/shop/screens/HomeScreen';
import { SearchScreen } from '../modules/shop/screens/SearchScreen';
import { OrdersScreen } from '../modules/orders/screens/OrdersScreen';
import { CourierScreen } from '../modules/movement/screens/CourierScreen';
import { AccountScreen } from '../screens/shared/AccountScreen';
import { VendorDetailScreen } from '../modules/shop/screens/VendorDetailScreen';
import { ItemDetailScreen } from '../modules/shop/screens/ItemDetailScreen';
import { VendorReviewsScreen } from '../modules/shop/screens/VendorReviewsScreen';
import { RateOrderScreen } from '../modules/orders/screens/RateOrderScreen';
import { FavoritesScreen } from '../modules/shop/screens/FavoritesScreen';
import { CartScreen } from '../modules/shop/screens/CartScreen';
import { CheckoutScreen } from '../modules/shop/screens/CheckoutScreen';
import { OrderTrackingScreen } from '../modules/orders/screens/OrderTrackingScreen';
import { TaxiScreen } from '../modules/movement/screens/TaxiScreen';
import { ServicesScreen } from '../modules/services/screens/ServicesScreen';
import { IdentityVerificationScreen } from '../modules/account/screens/IdentityVerificationScreen';
import { AddAddressScreen } from '../modules/account/screens/AddAddressScreen';
import { LocationPickerScreen } from '../modules/account/screens/LocationPickerScreen';
import { DestinationSearchScreen } from '../modules/movement/screens/DestinationSearchScreen';
import { PinConfirmScreen } from '../modules/movement/screens/PinConfirmScreen';
import { NotificationsScreen } from '../modules/account/screens/NotificationsScreen';
import { ChatScreen } from '../screens/shared/ChatScreen';
import { color } from '@swift/ui';
import { screenTransition } from '../components/ui';
import { Feather } from '@expo/vector-icons';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function HomeTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.brand[500],
        tabBarInactiveTintColor: color.text.muted,
        tabBarStyle: { backgroundColor: color.surface.base, borderTopColor: color.border.subtle },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarLabel: 'Home', tabBarIcon: ({ color: c, size }) => <Feather name="home" size={size} color={c} /> }}
      />
      <Tab.Screen
        name="Search"
        component={SearchScreen}
        options={{ tabBarLabel: 'Search', tabBarIcon: ({ color: c, size }) => <Feather name="search" size={size} color={c} /> }}
      />
      <Tab.Screen
        name="Orders"
        component={OrdersScreen}
        options={{ tabBarLabel: 'Orders', tabBarIcon: ({ color: c, size }) => <Feather name="clipboard" size={size} color={c} /> }}
      />
      <Tab.Screen
        name="Courier"
        component={CourierScreen}
        options={{ tabBarLabel: 'Send', tabBarIcon: ({ color: c, size }) => <Feather name="send" size={size} color={c} /> }}
      />
      <Tab.Screen
        name="Account"
        component={AccountScreen}
        options={{ tabBarLabel: 'Account', tabBarIcon: ({ color: c, size }) => <Feather name="user" size={size} color={c} /> }}
      />
    </Tab.Navigator>
  );
}

export function CustomerStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, ...screenTransition }}>
      <Stack.Screen name="Tabs" component={HomeTabs} />
      <Stack.Screen name="VendorDetail" component={VendorDetailScreen} />
      <Stack.Screen name="ItemDetail" component={ItemDetailScreen} />
      <Stack.Screen name="VendorReviews" component={VendorReviewsScreen} />
      <Stack.Screen name="RateOrder" component={RateOrderScreen} />
      <Stack.Screen name="Favorites" component={FavoritesScreen} />
      <Stack.Screen name="Cart" component={CartScreen} />
      <Stack.Screen name="Checkout" component={CheckoutScreen} />
      <Stack.Screen name="OrderTracking" component={OrderTrackingScreen} />
      <Stack.Screen name="Taxi" component={TaxiScreen} />
      <Stack.Screen name="Services" component={ServicesScreen} />
      <Stack.Screen name="IdentityVerification" component={IdentityVerificationScreen} />
      <Stack.Screen name="AddAddress" component={AddAddressScreen} />
      <Stack.Screen name="LocationPicker" component={LocationPickerScreen} />
      <Stack.Screen name="DestinationSearch" component={DestinationSearchScreen} />
      <Stack.Screen name="PinConfirm" component={PinConfirmScreen} />
      <Stack.Screen name="Notifications" component={NotificationsScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
    </Stack.Navigator>
  );
}
