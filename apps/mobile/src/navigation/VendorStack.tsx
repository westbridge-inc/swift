import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { VendorOrdersScreen } from '../screens/vendor/VendorOrdersScreen';
import { MenuManagementScreen } from '../screens/vendor/MenuManagementScreen';
import { VendorAnalyticsScreen } from '../screens/vendor/VendorAnalyticsScreen';
import { AccountScreen } from '../screens/shared/AccountScreen';
import { SWIFT_ORANGE } from '../theme/colors';

const Tab = createBottomTabNavigator();

export function VendorStack() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: SWIFT_ORANGE,
        tabBarInactiveTintColor: '#8E8E93',
        tabBarStyle: { backgroundColor: '#1C1C1E', borderTopColor: '#38383A' },
      }}
    >
      <Tab.Screen name="VendorOrders" component={VendorOrdersScreen} options={{ tabBarLabel: 'Orders' }} />
      <Tab.Screen name="Menu" component={MenuManagementScreen} />
      <Tab.Screen name="Analytics" component={VendorAnalyticsScreen} />
      <Tab.Screen name="Account" component={AccountScreen} />
    </Tab.Navigator>
  );
}
