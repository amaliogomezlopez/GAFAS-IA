import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Image, View, StyleSheet } from 'react-native';
import { HomeScreen } from '../screens/Home';
import { HistoryScreen } from '../screens/History';
import { SettingsScreen } from '../screens/Settings';
import { ProfileScreen } from '../screens/Profile';
import { DebugScreen } from '../screens/Debug';
import { COLORS } from '../constants';
import { useAppStore } from '../stores';

const Tab = createBottomTabNavigator();

const ProfileTabIcon: React.FC<{ color: string; size: number }> = ({ color, size }) => {
  const photoUri = useAppStore((s) => s.userProfile.photoUri);

  if (photoUri) {
    return (
      <View style={[tabIconStyles.avatarBorder, { borderColor: color }]}>
        <Image source={{ uri: photoUri }} style={tabIconStyles.avatar} />
      </View>
    );
  }

  return <Icon name="account-circle" size={size} color={color} />;
};

const tabIconStyles = StyleSheet.create({
  avatarBorder: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    overflow: 'hidden',
  },
  avatar: {
    width: '100%',
    height: '100%',
  },
});

export const AppNavigator: React.FC = () => {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: COLORS.surface,
          borderTopColor: COLORS.border,
          borderTopWidth: 1,
          height: 85,
          paddingBottom: 25,
          paddingTop: 8,
        },
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textSecondary,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarLabel: 'Inicio',
          tabBarIcon: ({ color, size }) => (
            <Icon name="home" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="History"
        component={HistoryScreen}
        options={{
          tabBarLabel: 'Historial',
          tabBarIcon: ({ color, size }) => (
            <Icon name="history" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarLabel: 'Ajustes',
          tabBarIcon: ({ color, size }) => (
            <Icon name="cog" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Debug"
        component={DebugScreen}
        options={{
          tabBarLabel: 'Debug',
          tabBarIcon: ({ color, size }) => (
            <Icon name="bug-check-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarLabel: 'Perfil',
          tabBarIcon: ({ color, size }) => (
            <ProfileTabIcon color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
};
