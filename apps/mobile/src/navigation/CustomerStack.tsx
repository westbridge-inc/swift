import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from '../screens/customer/HomeScreen';
import { SearchScreen } from '../screens/customer/SearchScreen';
import { OrdersScreen } from '../screens/customer/OrdersScreen';
import { CourierScreen } from '../screens/customer/CourierScreen';
import { AccountScreen } from '../screens/shared/AccountScreen';
import { VendorDetailScreen } from '../screens/customer/VendorDetailScreen';
import { CartScreen } from '../screens/customer/CartScreen';
import { OrderTrackingScreen } from '../screens/customer/OrderTrackingScreen';
import { SWIFT_ORANGE, colors } from '../theme/colors';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function HomeTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: SWIFT_ORANGE,
        tabBarInactiveTintColor: colors.light.text.tertiary,
        tabBarStyle: { backgroundColor: colors.light.background.primary, borderTopColor: colors.light.border.default },
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home' }} />
      <Tab.Screen name="Search" component={SearchScreen} options={{ tabBarLabel: 'Search' }} />
      <Tab.Screen name="Orders" component={OrdersScreen} options={{ tabBarLabel: 'Orders' }} />
      <Tab.Screen name="Courier" component={CourierScreen} options={{ tabBarLabel: 'Send' }} />
      <Tab.Screen name="Account" component={AccountScreen} options={{ tabBarLabel: 'Account' }} />
    </Tab.Navigator>
  );
}

export function CustomerStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs" component={HomeTabs} />
      <Stack.Screen name="VendorDetail" component={VendorDetailScreen} />
      <Stack.Screen name="Cart" component={CartScreen} />
      <Stack.Screen name="OrderTracking" component={OrderTrackingScreen} />
    </Stack.Navigator>
  );
}
