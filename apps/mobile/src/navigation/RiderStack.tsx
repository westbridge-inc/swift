import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { AvailableOrdersScreen } from '../screens/rider/AvailableOrdersScreen';
import { ActiveDeliveryScreen } from '../screens/rider/ActiveDeliveryScreen';
import { RiderEarningsScreen } from '../screens/rider/RiderEarningsScreen';
import { AccountScreen } from '../screens/shared/AccountScreen';
import { SWIFT_ORANGE } from '../theme/colors';

const Tab = createBottomTabNavigator();

export function RiderStack() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: SWIFT_ORANGE,
        tabBarInactiveTintColor: '#8E8E93',
        tabBarStyle: { backgroundColor: '#1C1C1E', borderTopColor: '#38383A' },
      }}
    >
      <Tab.Screen name="Available" component={AvailableOrdersScreen} />
      <Tab.Screen name="Active" component={ActiveDeliveryScreen} />
      <Tab.Screen name="Earnings" component={RiderEarningsScreen} />
      <Tab.Screen name="Account" component={AccountScreen} />
    </Tab.Navigator>
  );
}
