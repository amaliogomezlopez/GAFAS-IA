import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking, Platform } from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { COLORS } from '../constants';
import { PulseIndicator } from './PulseIndicator';

interface StatusBarProps {
  pipelineState: string;
  isBluetoothConnected: boolean;
  bluetoothDeviceName: string | null;
  batteryLevel?: number | null;
}

const STATE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  idle: { icon: 'shield-half-full', label: 'Listo', color: COLORS.textSecondary },
  listening: { icon: 'microphone', label: 'Escuchando', color: COLORS.listening },
  processing: { icon: 'brain', label: 'Procesando', color: COLORS.processing },
  speaking: { icon: 'volume-high', label: 'Hablando', color: COLORS.speaking },
};

const getBatteryIcon = (level: number): string => {
  if (level >= 90) return 'battery';
  if (level >= 70) return 'battery-70';
  if (level >= 50) return 'battery-50';
  if (level >= 30) return 'battery-30';
  if (level >= 10) return 'battery-10';
  return 'battery-alert-variant-outline';
};

const openBluetoothSettings = () => {
  if (Platform.OS === 'ios') {
    Linking.openURL('App-Prefs:Bluetooth');
  }
};

export const StatusBar: React.FC<StatusBarProps> = ({
  pipelineState,
  isBluetoothConnected,
  bluetoothDeviceName,
  batteryLevel,
}) => {
  const config = STATE_CONFIG[pipelineState] || STATE_CONFIG.idle;
  const btColor = isBluetoothConnected ? COLORS.success : COLORS.error;

  return (
    <View style={styles.container}>
      <View style={styles.stateContainer}>
        <PulseIndicator
          isActive={pipelineState !== 'idle'}
          color={config.color}
          size={8}
        />
        <Icon name={config.icon as any} size={20} color={config.color} />
        <Text style={[styles.stateText, { color: config.color }]}>
          {config.label}
        </Text>
      </View>

      <TouchableOpacity style={styles.bluetoothContainer} onPress={openBluetoothSettings}>
        <View style={[styles.btDot, { backgroundColor: btColor }]} />
        <Icon
          name={isBluetoothConnected ? 'bluetooth-connect' : 'bluetooth-off'}
          size={18}
          color={btColor}
        />
        {isBluetoothConnected && bluetoothDeviceName ? (
          <Text style={[styles.deviceName, { color: btColor }]} numberOfLines={1}>
            {bluetoothDeviceName}
          </Text>
        ) : (
          <Text style={[styles.deviceName, { color: btColor }]}>
            Desconectado
          </Text>
        )}
        {isBluetoothConnected && batteryLevel != null && (
          <View style={styles.batteryContainer}>
            <Icon
              name={getBatteryIcon(batteryLevel) as any}
              size={16}
              color={batteryLevel <= 20 ? COLORS.error : COLORS.success}
            />
            <Text style={[styles.batteryText, { color: batteryLevel <= 20 ? COLORS.error : COLORS.success }]}>
              {batteryLevel}%
            </Text>
          </View>
        )}
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderTopWidth: 1,
    borderTopColor: `${COLORS.primary}40`,
    marginHorizontal: 16,
    marginTop: 8,
  },
  stateContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stateText: {
    fontSize: 13,
    fontWeight: '600',
  },
  bluetoothContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  btDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  deviceName: {
    fontSize: 11,
    fontWeight: '500',
    maxWidth: 90,
  },
  batteryContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: 4,
  },
  batteryText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
