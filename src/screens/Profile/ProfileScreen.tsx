import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { COLORS, RADIUS, SPACING, withAlpha } from '../../constants';
import { useAppStore } from '../../stores';
import { Button, Card, Hint, ScreenHeader, SectionLabel } from '../../components';
import { isValidBirthday } from '../../utils/format';

/** Auto-insert dashes while typing digits: 19900615 → 1990-06-15. */
function formatBirthdayInput(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

function describeBirthday(value: string): string | null {
  if (!isValidBirthday(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const birth = new Date(year, month - 1, day);
  const today = new Date();
  let age = today.getFullYear() - year;
  const hadBirthday = today.getMonth() > birth.getMonth()
    || (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hadBirthday) age -= 1;
  const label = birth.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
  return `${label} · ${age} años`;
}

/**
 * The picker returns a URI in a temporary cache that iOS may purge, which
 * made the avatar disappear after a while. Keep our own copy instead.
 */
function persistPhoto(uri: string): string {
  try {
    const dir = new Directory(Paths.document, 'profile');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const source = new File(uri);
    const extension = uri.split('?')[0].split('.').pop()?.toLowerCase() || 'jpg';
    const target = new File(dir, `avatar_${Date.now()}.${extension}`);
    source.copy(target);
    // Remove previous avatars so they don't accumulate.
    dir.list().forEach((entry) => {
      if (entry.uri !== target.uri && entry.uri.includes('avatar_')) {
        try { new File(entry.uri).delete(); } catch {}
      }
    });
    return target.uri;
  } catch {
    return uri;
  }
}

export const ProfileScreen: React.FC = () => {
  const userProfile = useAppStore((s) => s.userProfile);
  const updateUserProfile = useAppStore((s) => s.updateUserProfile);
  const sessionCount = useAppStore((s) => s.chatSessions.filter((session) => session.entries.length > 0).length);
  const messageCount = useAppStore((s) => s.chatSessions.reduce((sum, session) => sum + session.entries.length, 0));
  const aiLabel = useAppStore((s) => s.settings.wakeWord.trim().toUpperCase() || 'KAIRO');

  const [name, setName] = useState(userProfile.name);
  const [birthday, setBirthday] = useState(userProfile.birthday);

  // The stored profile loads asynchronously at startup; follow it until edited.
  useEffect(() => {
    setName(userProfile.name);
    setBirthday(userProfile.birthday);
  }, [userProfile.name, userProfile.birthday]);

  const trimmedName = name.trim();
  const trimmedBirthday = birthday.trim();
  const birthdayInvalid = trimmedBirthday.length > 0 && !isValidBirthday(trimmedBirthday);
  const isDirty = trimmedName !== userProfile.name || trimmedBirthday !== userProfile.birthday;
  const birthdayInfo = useMemo(() => describeBirthday(userProfile.birthday), [userProfile.birthday]);
  const initials = (userProfile.name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

  const handleSave = () => {
    if (birthdayInvalid) {
      Alert.alert('Fecha no válida', 'Usa el formato AAAA-MM-DD con una fecha real, por ejemplo 1990-06-15.');
      return;
    }
    updateUserProfile({ name: trimmedName, birthday: trimmedBirthday });
    Alert.alert('Perfil guardado', trimmedName ? `${aiLabel} te llamará ${trimmedName}.` : 'Tu perfil se ha actualizado.');
  };

  const handlePickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permiso requerido', 'Necesitamos acceso a tus fotos para elegir una imagen de perfil.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.6,
    });

    if (!result.canceled && result.assets[0]) {
      updateUserProfile({ photoUri: persistPhoto(result.assets[0].uri) });
    }
  };

  const handleRemovePhoto = () => {
    Alert.alert('Quitar foto', '¿Quitar tu foto de perfil?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Quitar', style: 'destructive', onPress: () => updateUserProfile({ photoUri: null }) },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ScreenHeader title="Mi perfil" subtitle={`${aiLabel} usa estos datos para personalizar la conversación.`} />

          <Card style={styles.hero}>
            <Pressable
              onPress={handlePickPhoto}
              accessibilityRole="button"
              accessibilityLabel="Cambiar foto de perfil"
              style={({ pressed }) => [styles.avatar, pressed && { opacity: 0.8 }]}
            >
              {userProfile.photoUri ? (
                <Image source={{ uri: userProfile.photoUri }} style={styles.avatarImage} />
              ) : (
                <Text style={styles.avatarInitials}>{initials}</Text>
              )}
              <View style={styles.avatarBadge}>
                <Icon name="camera" size={14} color={COLORS.onPrimary} />
              </View>
            </Pressable>
            <Text style={styles.heroName}>{userProfile.name || 'Sin nombre'}</Text>
            {birthdayInfo ? (
              <View style={styles.heroMetaRow}>
                <Icon name="cake-variant-outline" size={14} color={COLORS.accent} />
                <Text style={styles.heroMeta}>{birthdayInfo}</Text>
              </View>
            ) : null}
            {userProfile.photoUri ? (
              <Button label="Quitar foto" variant="ghost" compact onPress={handleRemovePhoto} />
            ) : null}

            <View style={styles.stats}>
              <View style={styles.stat}>
                <Text style={styles.statValue}>{sessionCount}</Text>
                <Text style={styles.statLabel}>Conversaciones</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statValue}>{messageCount}</Text>
                <Text style={styles.statLabel}>Mensajes</Text>
              </View>
            </View>
          </Card>

          <SectionLabel>Datos personales</SectionLabel>
          <Card>
            <Text style={styles.label}>Nombre</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="¿Cómo quieres que te llame?"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="words"
              autoComplete="name"
              textContentType="givenName"
              returnKeyType="next"
              maxLength={60}
            />

            <Text style={[styles.label, { marginTop: SPACING.md }]}>Cumpleaños</Text>
            <TextInput
              style={[styles.input, birthdayInvalid && styles.inputError]}
              value={birthday}
              onChangeText={(text) => setBirthday(formatBirthdayInput(text))}
              placeholder="AAAA-MM-DD"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="number-pad"
              maxLength={10}
            />
            {birthdayInvalid ? (
              <Text style={styles.errorText}>Introduce una fecha real con el formato AAAA-MM-DD.</Text>
            ) : null}

            <Button
              label={isDirty ? 'Guardar cambios' : 'Guardado'}
              icon={isDirty ? 'content-save-outline' : 'check'}
              variant={isDirty ? 'primary' : 'secondary'}
              onPress={handleSave}
              disabled={!isDirty}
              style={{ marginTop: SPACING.lg }}
            />
          </Card>

          <View style={styles.infoBox}>
            <Icon name="shield-lock-outline" size={18} color={COLORS.primary} />
            <Hint style={styles.flex}>
              Tus datos se guardan solo en este iPhone. {aiLabel} usará tu nombre para dirigirse a ti y podrá felicitarte en tu cumpleaños.
            </Hint>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const AVATAR_SIZE = 104;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  flex: { flex: 1 },
  content: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xl },
  hero: { alignItems: 'center', paddingVertical: SPACING.lg, gap: 6 },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    borderWidth: 2,
    borderColor: COLORS.primary,
    backgroundColor: withAlpha(COLORS.primary, 0.1),
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  avatarImage: {
    width: '100%',
    height: '100%',
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarInitials: {
    fontSize: 38,
    fontWeight: '800',
    color: COLORS.primary,
  },
  avatarBadge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.primary,
    borderWidth: 3,
    borderColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroName: { fontSize: 22, fontWeight: '800', color: COLORS.text },
  heroMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroMeta: { fontSize: 13, color: COLORS.textSecondary },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: SPACING.md,
    paddingTop: SPACING.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontSize: 22, fontWeight: '800', color: COLORS.text },
  statLabel: { fontSize: 12, color: COLORS.textSecondary },
  statDivider: { width: StyleSheet.hairlineWidth, height: 32, backgroundColor: COLORS.border },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textSecondary,
    marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: COLORS.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  inputError: { borderColor: COLORS.error },
  errorText: { color: COLORS.error, fontSize: 12, marginTop: 6 },
  infoBox: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: withAlpha(COLORS.primary, 0.07),
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.primary, 0.2),
    padding: 14,
    marginTop: SPACING.md,
    alignItems: 'flex-start',
  },
});
