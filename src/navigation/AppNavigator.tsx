import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { Image, View, StyleSheet } from 'react-native';
import { HomeScreen } from '../screens/Home';
import { HistoryScreen } from '../screens/History';
import { SettingsScreen } from '../screens/Settings';
import { ProfileScreen } from '../screens/Profile';
import { DebugScreen } from '../screens/Debug';
import { COLORS, withAlpha } from '../constants';
import { useAppStore } from '../stores';

const Tab = createBottomTabNavigator();

/** Home icon with a live dot while KAIRO is listening, thinking or talking. */
const HomeTabIcon: React.FC<{ color: string; size: number }> = ({ color, size }) => {
  const pipelineState = useAppStore((s) => s.pipelineState);
  const busyColor =
    pipelineState === 'listening' ? COLORS.listening :
    pipelineState === 'processing' ? COLORS.processing :
    pipelineState === 'speaking' ? COLORS.speaking :
    null;
  return (
    <View>
      <Icon name="shield-half-full" size={size} color={color} />
      {busyColor ? <View style={[tabIconStyles.liveDot, { backgroundColor: busyColor }]} /> : null}
    </View>
  );
};

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
  liveDot: {
    position: 'absolute',
    top: -1,
    right: -3,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: COLORS.card,
  },
});

export const AppNavigator: React.FC = () => {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        // Height/padding come from the safe-area insets; hard-coding them
        // broke the layout on devices without a home indicator and on Android.
        tabBarStyle: {
          backgroundColor: COLORS.card,
          borderTopColor: COLORS.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textMuted,
        tabBarActiveBackgroundColor: withAlpha(COLORS.primary, 0.06),
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '700',
        },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarLabel: 'KAIRO',
          tabBarIcon: ({ color, size }) => <HomeTabIcon color={color} size={size} />,
        }}
      />
      <Tab.Screen
        name="History"
        component={HistoryScreen}
        options={{
          tabBarLabel: 'Historial',
          tabBarIcon: ({ color, size }) => (
            <Icon name="message-text-clock-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarLabel: 'Ajustes',
          tabBarIcon: ({ color, size }) => (
            <Icon name="tune-variant" size={size} color={color} />
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
