import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { AvailableRidesScreen } from '../screens/driver/AvailableRidesScreen';
import { ActiveRideScreen } from '../screens/driver/ActiveRideScreen';
import { DriverEarningsScreen } from '../screens/driver/DriverEarningsScreen';
import { AccountScreen } from '../screens/shared/AccountScreen';
import { SWIFT_ORANGE } from '../theme/colors';

const Tab = createBottomTabNavigator();

export function DriverStack() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: SWIFT_ORANGE,
        tabBarInactiveTintColor: '#8E8E93',
        tabBarStyle: { backgroundColor: '#1C1C1E', borderTopColor: '#38383A' },
      }}
    >
      <Tab.Screen name="Online" component={AvailableRidesScreen} />
      <Tab.Screen name="Rides" component={ActiveRideScreen} />
      <Tab.Screen name="Earnings" component={DriverEarningsScreen} />
      <Tab.Screen name="Account" component={AccountScreen} />
    </Tab.Navigator>
  );
}
