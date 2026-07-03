import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { COLORS, DEFAULT_PROFILES } from '../constants';

const GRID_GAP = 10;
const HORIZONTAL_PADDING = 16;
const CARD_WIDTH = (Dimensions.get('window').width - HORIZONTAL_PADDING * 2 - GRID_GAP) / 2;

interface ProfileSelectorProps {
  activeProfile: string;
  onSelectProfile: (profileId: string) => void;
}

export const ProfileSelector: React.FC<ProfileSelectorProps> = ({
  activeProfile,
  onSelectProfile,
}) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Perfil Activo</Text>
      <View style={styles.grid}>
        {DEFAULT_PROFILES.map((profile) => {
          const isActive = profile.id === activeProfile;
          return (
            <TouchableOpacity
              key={profile.id}
              style={[
                styles.profileCard,
                isActive && styles.activeCard,
              ]}
              onPress={() => onSelectProfile(profile.id)}
            >
              <Icon
                name={profile.icon as any}
                size={28}
                color={isActive ? COLORS.primary : COLORS.textSecondary}
              />
              <Text
                style={[
                  styles.profileName,
                  isActive && styles.activeName,
                ]}
                numberOfLines={1}
              >
                {profile.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginHorizontal: HORIZONTAL_PADDING,
    marginTop: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 12,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  profileCard: {
    width: CARD_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  activeCard: {
    borderColor: COLORS.primary,
    backgroundColor: `${COLORS.primary}15`,
  },
  profileName: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 6,
    fontWeight: '600',
  },
  activeName: {
    color: COLORS.primary,
  },
});
