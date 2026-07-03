import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation';
import { COLORS } from './src/constants';
import { useAppStore } from './src/stores';
import { LogService } from './src/services/LogService';

const DarkTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: COLORS.primary,
    background: COLORS.background,
    card: COLORS.surface,
    text: COLORS.text,
    border: COLORS.border,
    notification: COLORS.error,
  },
};

export default function App() {
  const loadUserProfile = useAppStore((s) => s.loadUserProfile);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const loadSettings = useAppStore((s) => s.loadSettings);

  useEffect(() => {
    LogService.load();
    loadUserProfile();
    loadSessions();
    loadSettings();
  }, [loadUserProfile, loadSessions, loadSettings]);

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={DarkTheme}>
        <StatusBar style="light" />
        <AppNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
