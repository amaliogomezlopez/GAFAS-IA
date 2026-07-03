import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { COLORS } from '../constants';

interface ActionButtonProps {
  onPress: () => void;
  isActive: boolean;
  pipelineState: string;
}

export const ActionButton: React.FC<ActionButtonProps> = ({
  onPress,
  isActive,
  pipelineState,
}) => {
  const getButtonConfig = () => {
    switch (pipelineState) {
      case 'listening':
        return { icon: 'stop', label: 'Pulsa para enviar', color: COLORS.error };
      case 'processing':
        return { icon: 'brain', label: 'Procesando...', color: COLORS.accent };
      case 'speaking':
        return { icon: 'volume-high', label: 'Reproduciendo...', color: COLORS.success };
      default:
        return { icon: 'microphone-outline', label: 'Pulsa para hablar', color: COLORS.primary };
    }
  };

  const config = getButtonConfig();
  const isDisabled = pipelineState === 'processing' || pipelineState === 'speaking';

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[
          styles.button,
          { backgroundColor: isActive ? `${config.color}30` : COLORS.surface },
          isActive && { borderColor: config.color, borderWidth: 2 },
        ]}
        onPress={onPress}
        disabled={isDisabled}
        activeOpacity={0.7}
      >
        <Icon name={config.icon as any} size={48} color={config.color} />
      </TouchableOpacity>
      <Text style={[styles.label, { color: config.color }]}>{config.label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 12,
  },
  button: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
});
