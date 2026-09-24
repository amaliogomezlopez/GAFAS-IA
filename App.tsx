import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme as NavigationDarkTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation';
import { COLORS } from './src/constants';
import { useAppStore } from './src/stores';
import { LogService } from './src/services/LogService';

const DarkTheme = {
  ...NavigationDarkTheme,
  colors: {
    ...NavigationDarkTheme.colors,
    primary: COLORS.primary,
    background: COLORS.background,
    card: COLORS.card,
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
