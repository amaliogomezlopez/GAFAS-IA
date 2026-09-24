import React, { useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { COLORS, RADIUS, SPACING, withAlpha } from '../../constants';
import { useAppStore } from '../../stores';
import { Button, EmptyState, IconButton, ScreenHeader } from '../../components';
import { formatRelativeDate, formatTime } from '../../utils/format';
import type { ChatSession, ConversationEntry } from '../../types';

function sessionMatches(session: ChatSession, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    session.name.toLowerCase().includes(needle) ||
    session.entries.some((entry) =>
      entry.userMessage.content.toLowerCase().includes(needle) ||
      entry.assistantMessage.content.toLowerCase().includes(needle),
    )
  );
}

function sessionToText(session: ChatSession, aiLabel: string): string {
  const lines = [...session.entries].reverse().flatMap((entry) => [
    `[${formatTime(entry.userMessage.timestamp)}] Tú: ${entry.userMessage.content}`,
    `[${formatTime(entry.assistantMessage.timestamp)}] ${aiLabel}: ${entry.assistantMessage.content}`,
    '',
  ]);
  return `${session.name}\n${new Date(session.createdAt).toLocaleString('es-ES')}\n\n${lines.join('\n')}`.trim();
}

export const HistoryScreen: React.FC = () => {
  const chatSessions = useAppStore((s) => s.chatSessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const pipelineState = useAppStore((s) => s.pipelineState);
  const aiLabel = useAppStore((s) => s.settings.wakeWord.trim().toUpperCase() || 'KAIRO');
  const clearHistory = useAppStore((s) => s.clearHistory);
  const renameSession = useAppStore((s) => s.renameSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const deleteEntry = useAppStore((s) => s.deleteEntry);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const navigation = useNavigation();

  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [query, setQuery] = useState('');

  const sortedSessions = useMemo(
    () => [...chatSessions]
      .filter((session) => session.entries.length > 0 || session.id === activeSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [activeSessionId, chatSessions],
  );
  const visibleSessions = useMemo(
    () => sortedSessions.filter((session) => sessionMatches(session, query.trim())),
    [query, sortedSessions],
  );
  const totalMessages = useMemo(
    () => chatSessions.reduce((sum, session) => sum + session.entries.length, 0),
    [chatSessions],
  );

  const handleClearAll = () => {
    Alert.alert(
      'Borrar todo el historial',
      `Se eliminarán ${sortedSessions.length} conversaciones. Esta acción no se puede deshacer.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Borrar todo', style: 'destructive', onPress: clearHistory },
      ],
    );
  };

  const handleDeleteSession = (session: ChatSession) => {
    Alert.alert(
      'Borrar conversación',
      `¿Borrar "${session.name}" y sus ${session.entries.length} mensajes?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
          style: 'destructive',
          onPress: () => {
            if (expandedSessionId === session.id) setExpandedSessionId(null);
            deleteSession(session.id);
          },
        },
      ],
    );
  };

  const handleDeleteEntry = (entryId: string) => {
    Alert.alert('Borrar mensaje', '¿Borrar esta pregunta y su respuesta?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Borrar', style: 'destructive', onPress: () => deleteEntry(entryId) },
    ]);
  };

  const handleContinue = (session: ChatSession) => {
    if (pipelineState !== 'idle') {
      Alert.alert('KAIRO está ocupado', 'Espera a que termine el turno actual para cambiar de conversación.');
      return;
    }
    setActiveSession(session.id);
    navigation.navigate('Home' as never);
  };

  const handleShare = (session: ChatSession) => {
    Share.share({ title: session.name, message: sessionToText(session, aiLabel) }).catch(() => {});
  };

  const startEditing = (session: ChatSession) => {
    setEditingSessionId(session.id);
    setEditName(session.name);
  };

  const finishEditing = () => {
    if (editingSessionId && editName.trim()) {
      renameSession(editingSessionId, editName.trim());
    }
    setEditingSessionId(null);
    setEditName('');
  };

  const renderEntry = (item: ConversationEntry) => (
    <View key={item.id} style={styles.entry}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryTime}>{formatTime(item.createdAt)}</Text>
        <IconButton
          icon="trash-can-outline"
          label="Borrar mensaje"
          onPress={() => handleDeleteEntry(item.id)}
          size={16}
          style={styles.entryDelete}
        />
      </View>
      <View style={[styles.entryBubble, styles.entryUser]}>
        <Text style={styles.entryText} selectable>{item.userMessage.content}</Text>
      </View>
      <View style={[styles.entryBubble, styles.entryAI]}>
        <Text style={styles.entryLabel}>{aiLabel}</Text>
        <Text style={styles.entryText} selectable>{item.assistantMessage.content}</Text>
      </View>
    </View>
  );

  const renderSession = ({ item }: { item: ChatSession }) => {
    const isExpanded = expandedSessionId === item.id;
    const isEditing = editingSessionId === item.id;
    const isActive = item.id === activeSessionId;
    const lastEntry = item.entries[0];
    const preview = lastEntry ? lastEntry.assistantMessage.content || lastEntry.userMessage.content : 'Sin mensajes todavía';

    return (
      <View style={[styles.sessionCard, isActive && styles.sessionCardActive]}>
        <Pressable
          style={({ pressed }) => [styles.sessionHeader, pressed && { opacity: 0.75 }]}
          onPress={() => setExpandedSessionId(isExpanded ? null : item.id)}
          accessibilityRole="button"
          accessibilityState={{ expanded: isExpanded }}
          accessibilityLabel={`${item.name}, ${item.entries.length} mensajes`}
        >
          <View style={[styles.sessionIcon, isActive && { backgroundColor: withAlpha(COLORS.primary, 0.18) }]}>
            <Icon name={isActive ? 'message-flash' : 'message-text-outline'} size={20} color={isActive ? COLORS.primary : COLORS.textSecondary} />
          </View>
          <View style={styles.sessionInfo}>
            {isEditing ? (
              <TextInput
                style={styles.editInput}
                value={editName}
                onChangeText={setEditName}
                onBlur={finishEditing}
                onSubmitEditing={finishEditing}
                autoFocus
                selectTextOnFocus
                returnKeyType="done"
                maxLength={60}
              />
            ) : (
              <View style={styles.sessionTitleRow}>
                <Text style={styles.sessionName} numberOfLines={1}>{item.name}</Text>
                {isActive ? <Text style={styles.activeBadge}>ACTUAL</Text> : null}
              </View>
            )}
            <Text style={styles.sessionPreview} numberOfLines={isExpanded ? 1 : 2}>{preview}</Text>
            <Text style={styles.sessionMeta}>
              {formatRelativeDate(item.updatedAt)} · {item.entries.length} mensaje{item.entries.length !== 1 ? 's' : ''}
            </Text>
          </View>
          <Icon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={22} color={COLORS.textMuted} />
        </Pressable>

        {isExpanded ? (
          <View style={styles.expanded}>
            <View style={styles.actions}>
              <Button label={isActive ? 'Abrir' : 'Continuar'} icon="message-reply-text-outline" variant="primary" compact onPress={() => handleContinue(item)} style={styles.actionMain} />
              <IconButton icon="pencil-outline" label="Renombrar" onPress={() => startEditing(item)} filled color={COLORS.text} />
              <IconButton icon="share-variant-outline" label="Compartir" onPress={() => handleShare(item)} filled color={COLORS.text} disabled={item.entries.length === 0} />
              <IconButton icon="trash-can-outline" label="Borrar conversación" onPress={() => handleDeleteSession(item)} filled color={COLORS.error} />
            </View>
            {item.entries.length === 0 ? (
              <Text style={styles.noEntries}>Conversación vacía</Text>
            ) : (
              [...item.entries].reverse().map(renderEntry)
            )}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScreenHeader
        title="Historial"
        subtitle={sortedSessions.length
          ? `${sortedSessions.length} conversaciones · ${totalMessages} mensajes`
          : 'Tus conversaciones con KAIRO'}
        right={sortedSessions.length > 0 ? (
          <IconButton icon="delete-sweep-outline" label="Borrar todo el historial" onPress={handleClearAll} color={COLORS.error} filled />
        ) : undefined}
      />

      {sortedSessions.length === 0 ? (
        <EmptyState
          icon="chat-processing-outline"
          title="Sin conversaciones"
          subtitle="Lo que hables con KAIRO por voz o texto aparecerá aquí para que puedas retomarlo."
          action={<Button label="Empezar a hablar" icon="microphone" variant="primary" onPress={() => navigation.navigate('Home' as never)} style={{ marginTop: SPACING.md }} />}
        />
      ) : (
        <FlatList
          data={visibleSessions}
          keyExtractor={(item) => item.id}
          renderItem={renderSession}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={(
            <View style={styles.searchWrap}>
              <Icon name="magnify" size={20} color={COLORS.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Buscar en conversaciones"
                placeholderTextColor={COLORS.textMuted}
                returnKeyType="search"
                autoCorrect={false}
                clearButtonMode="while-editing"
                accessibilityLabel="Buscar en conversaciones"
              />
            </View>
          )}
          ListEmptyComponent={(
            <Text style={styles.noResults}>No hay resultados para “{query.trim()}”.</Text>
          )}
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  list: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xl, gap: 10 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  searchInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: 15,
    paddingVertical: 11,
  },
  noResults: {
    color: COLORS.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: SPACING.lg,
  },
  sessionCard: {
    backgroundColor: COLORS.card,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  sessionCardActive: {
    borderColor: withAlpha(COLORS.primary, 0.45),
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  sessionIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surfaceLight,
  },
  sessionInfo: { flex: 1, gap: 3 },
  sessionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sessionName: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: COLORS.text },
  activeBadge: {
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
    color: COLORS.primary,
    backgroundColor: withAlpha(COLORS.primary, 0.14),
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  sessionPreview: { fontSize: 13, color: COLORS.textSecondary, lineHeight: 18 },
  sessionMeta: { fontSize: 11, color: COLORS.textMuted, fontWeight: '600' },
  editInput: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    backgroundColor: COLORS.background,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  expanded: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  actionMain: { flex: 1 },
  entry: {
    paddingTop: 10,
    gap: 6,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  entryTime: { fontSize: 11, color: COLORS.textMuted, fontWeight: '700' },
  entryDelete: { width: 28, height: 28 },
  entryBubble: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
    maxWidth: '92%',
  },
  entryUser: {
    alignSelf: 'flex-end',
    backgroundColor: withAlpha(COLORS.primary, 0.12),
    borderBottomRightRadius: 4,
  },
  entryAI: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.surface,
    borderBottomLeftRadius: 4,
  },
  entryLabel: { fontSize: 9, fontWeight: '900', color: COLORS.primary, letterSpacing: 0.8, marginBottom: 2 },
  entryText: { fontSize: 14, color: COLORS.text, lineHeight: 20 },
  noEntries: { fontSize: 13, color: COLORS.textSecondary, paddingVertical: 8 },
});
