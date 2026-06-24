import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from '../screens/customer/HomeScreen';
import { SearchScreen } from '../screens/customer/SearchScreen';
import { OrdersScreen } from '../screens/customer/OrdersScreen';
import { CourierScreen } from '../modules/movement/screens/CourierScreen';
import { AccountScreen } from '../screens/shared/AccountScreen';
import { VendorDetailScreen } from '../screens/customer/VendorDetailScreen';
import { ItemDetailScreen } from '../screens/customer/ItemDetailScreen';
import { VendorReviewsScreen } from '../screens/customer/VendorReviewsScreen';
import { RateOrderScreen } from '../screens/customer/RateOrderScreen';
import { CartScreen } from '../screens/customer/CartScreen';
import { CheckoutScreen } from '../screens/customer/CheckoutScreen';
import { OrderTrackingScreen } from '../screens/customer/OrderTrackingScreen';
import { TaxiScreen } from '../modules/movement/screens/TaxiScreen';
import { ServicesScreen } from '../modules/services/screens/ServicesScreen';
import { IdentityVerificationScreen } from '../screens/customer/IdentityVerificationScreen';
import { AddAddressScreen } from '../screens/customer/AddAddressScreen';
import { LocationPickerScreen } from '../screens/customer/LocationPickerScreen';
import { DestinationSearchScreen } from '../modules/movement/screens/DestinationSearchScreen';
import { PinConfirmScreen } from '../modules/movement/screens/PinConfirmScreen';
import { NotificationsScreen } from '../screens/customer/NotificationsScreen';
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
