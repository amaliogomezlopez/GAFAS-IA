import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Image,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { COLORS } from '../../constants';
import { useAppStore } from '../../stores';

export const ProfileScreen: React.FC = () => {
  const { userProfile, updateUserProfile } = useAppStore();
  const [name, setName] = useState(userProfile.name);
  const [birthday, setBirthday] = useState(userProfile.birthday);

  const handleSave = () => {
    updateUserProfile({ name: name.trim(), birthday: birthday.trim() });
    Alert.alert('Guardado', 'Tu perfil se ha guardado correctamente.');
  };

  const handlePickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permiso requerido', 'Necesitamos acceso a tus fotos para seleccionar una imagen de perfil.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });

    if (!result.canceled && result.assets[0]) {
      updateUserProfile({ photoUri: result.assets[0].uri });
    }
  };

  const handleRemovePhoto = () => {
    updateUserProfile({ photoUri: null });
  };

  const formatBirthdayInput = (text: string) => {
    // Allow only digits and dashes
    const cleaned = text.replace(/[^0-9-]/g, '');
    setBirthday(cleaned);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Mi Perfil</Text>
        <Text style={styles.subtitle}>
          Tu agente inteligente usará estos datos para personalizar la conversación.
        </Text>

        {/* Photo */}
        <View style={styles.photoSection}>
          <TouchableOpacity onPress={handlePickPhoto} style={styles.photoContainer}>
            {userProfile.photoUri ? (
              <Image source={{ uri: userProfile.photoUri }} style={styles.photo} />
            ) : (
              <View style={styles.photoPlaceholder}>
                <Icon name="camera-plus" size={36} color={COLORS.textSecondary} />
              </View>
            )}
          </TouchableOpacity>
          {userProfile.photoUri && (
            <TouchableOpacity onPress={handleRemovePhoto} style={styles.removePhoto}>
              <Icon name="close-circle" size={24} color={COLORS.error} />
            </TouchableOpacity>
          )}
          <Text style={styles.photoHint}>Toca para cambiar la foto</Text>
        </View>

        {/* Name */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Nombre</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Tu nombre..."
            placeholderTextColor={COLORS.textSecondary}
            autoCapitalize="words"
          />
        </View>

        {/* Birthday */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Cumpleaños (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            value={birthday}
            onChangeText={formatBirthdayInput}
            placeholder="1990-06-15"
            placeholderTextColor={COLORS.textSecondary}
            keyboardType="numbers-and-punctuation"
            maxLength={10}
          />
        </View>

        {/* Save Button */}
        <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
          <Icon name="content-save" size={20} color="#FFF" />
          <Text style={styles.saveButtonText}>Guardar Perfil</Text>
        </TouchableOpacity>

        {/* Info */}
        <View style={styles.infoBox}>
          <Icon name="information-outline" size={18} color={COLORS.primary} />
          <Text style={styles.infoText}>
            El agente te llamará por tu nombre y podrá referenciar tu cumpleaños en las conversaciones.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: 24,
  },
  photoSection: {
    alignItems: 'center',
    marginBottom: 28,
  },
  photoContainer: {
    width: 100,
    height: 100,
    borderRadius: 50,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  photoPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removePhoto: {
    position: 'absolute',
    right: '35%',
    top: -4,
  },
  photoHint: {
    marginTop: 8,
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: COLORS.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  saveButton: {
    flexDirection: 'row',
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 8,
    marginBottom: 20,
  },
  saveButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  infoBox: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: `${COLORS.primary}15`,
    borderRadius: 10,
    padding: 12,
    alignItems: 'flex-start',
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.textSecondary,
    lineHeight: 18,
  },
});
